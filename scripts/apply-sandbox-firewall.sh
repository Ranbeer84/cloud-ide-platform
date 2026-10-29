#!/usr/bin/env bash
# Host firewall for sandbox containers (Docker deployments).
#
# WHY THIS EXISTS
#   Docker gives each session its own network, which isolates sandboxes from one
#   another. It does NOT stop a container from connecting to the host through
#   its bridge's gateway address, to the host's other interfaces, to cloud
#   metadata (169.254.169.254) or to private networks. Only host firewall rules
#   can do that, so this script installs them.
#
# WHAT IT DOES
#   Every rule is scoped to the bridge interfaces named "lsbx*" (one per session,
#   see GvisorManager), so containers on any other Docker network are untouched.
#     FORWARD (DOCKER-USER chain):
#       - replies to connections a sandbox opened are allowed back
#       - traffic that stays on the session's own bridge is allowed (Traefik <-> sandbox)
#       - connections to link-local (metadata) and private address ranges are dropped
#       - everything else, i.e. the public internet, is left to Docker's own rules
#     INPUT (traffic addressed to the host itself):
#       - replies on established connections are accepted (published-port traffic needs this)
#       - every new connection from a sandbox bridge to the host is dropped
#   Traffic between two different session networks is dropped by Docker's own
#   network isolation; verify.sh proves it.
#
# USAGE (needs root, and Docker must be running so the DOCKER-USER chain exists)
#   apply-sandbox-firewall.sh apply    install the rules (safe to run repeatedly)
#   apply-sandbox-firewall.sh remove   delete exactly the rules this script added
#   apply-sandbox-firewall.sh status   exit 0 if the rules are installed, 1 if not
#
# LIMITS
#   - iptables rules do not survive a reboot. Run "apply" at boot (a systemd unit
#     ordered After=docker.service) or the sandboxes lose this protection.
#   - IPv4 only. The sandbox networks are created without IPv6.
#   - Linux only (gVisor already requires Linux). Not applicable to Docker Desktop.
set -euo pipefail

TAG="live-sandbox-fw"
BRIDGES="lsbx+"
FORWARD_CHAIN="DOCKER-USER"
INPUT_CHAIN="INPUT"
BLOCKED_RANGES=(169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10)

die() {
  echo "apply-sandbox-firewall: $1" >&2
  exit 1
}

command -v iptables > /dev/null 2>&1 || die "iptables is not installed"
[ "$(id -u)" = "0" ] || die "must run as root (try: sudo $0 ${1:-apply})"

tagged_rules() {
  # Prints "<chain> <rule spec...>" for every rule carrying our tag, in either chain.
  local chain
  for chain in "$FORWARD_CHAIN" "$INPUT_CHAIN"; do
    iptables -S "$chain" 2> /dev/null | grep -- "--comment $TAG" || true
  done
}

remove_rules() {
  local line
  local parts
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    read -r -a parts <<< "$line"
    # "-A CHAIN spec..." becomes "-D CHAIN spec..."
    iptables -D "${parts[@]:1}"
  done < <(tagged_rules)
}

apply_rules() {
  iptables -n -L "$FORWARD_CHAIN" > /dev/null 2>&1 \
    || die "chain $FORWARD_CHAIN does not exist; is Docker running?"

  # Start clean so repeated runs never stack duplicates or leave a stale order.
  remove_rules

  # Rules are inserted at position 1 in REVERSE, so the final order reads top to bottom as listed.
  local position=1
  local range
  # --- FORWARD (DOCKER-USER), final order:
  #   1 established/related -> RETURN
  #   2 same session bridge -> RETURN
  #   3.. blocked ranges    -> DROP
  for ((i = ${#BLOCKED_RANGES[@]} - 1; i >= 0; i--)); do
    range="${BLOCKED_RANGES[$i]}"
    iptables -I "$FORWARD_CHAIN" 1 -i "$BRIDGES" -d "$range" -m comment --comment "$TAG" -j DROP
  done
  iptables -I "$FORWARD_CHAIN" 1 -i "$BRIDGES" -o "$BRIDGES" -m comment --comment "$TAG" -j RETURN
  iptables -I "$FORWARD_CHAIN" 1 -i "$BRIDGES" -m conntrack --ctstate ESTABLISHED,RELATED \
    -m comment --comment "$TAG" -j RETURN

  # --- INPUT, final order:
  #   1 established/related -> ACCEPT
  #   2 everything else from a sandbox bridge -> DROP
  iptables -I "$INPUT_CHAIN" "$position" -i "$BRIDGES" -m comment --comment "$TAG" -j DROP
  iptables -I "$INPUT_CHAIN" "$position" -i "$BRIDGES" -m conntrack --ctstate ESTABLISHED,RELATED \
    -m comment --comment "$TAG" -j ACCEPT

  echo "sandbox firewall installed:"
  tagged_rules | sed 's/^/  /'
}

status_rules() {
  local expected_forward=$((${#BLOCKED_RANGES[@]} + 2))
  local forward_count input_count
  forward_count="$(iptables -S "$FORWARD_CHAIN" 2> /dev/null | grep -c -- "--comment $TAG" || true)"
  input_count="$(iptables -S "$INPUT_CHAIN" 2> /dev/null | grep -c -- "--comment $TAG" || true)"
  if [ "$forward_count" -eq "$expected_forward" ] && [ "$input_count" -eq 2 ]; then
    echo "sandbox firewall: installed ($forward_count forward rules, $input_count input rules)"
    return 0
  fi
  echo "sandbox firewall: NOT installed (forward $forward_count/$expected_forward, input $input_count/2)"
  return 1
}

case "${1:-}" in
  apply) apply_rules ;;
  remove)
    remove_rules
    echo "sandbox firewall removed"
    ;;
  status) status_rules ;;
  *) die "usage: $0 {apply|remove|status}" ;;
esac