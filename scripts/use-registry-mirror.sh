#!/usr/bin/env bash
# Routes Docker Hub pulls through Google's public mirror (mirror.gcr.io), falling back to
# Docker Hub for anything the mirror does not have. Use it when pulls hit
# "TLS handshake timeout" but the mirror is reachable (scripts/doctor.sh tells you).
#
#   bash scripts/use-registry-mirror.sh on | off | status
set -euo pipefail
MIRROR="https://mirror.gcr.io"
CONF="${DAEMON_JSON:-/etc/docker/daemon.json}"
ACTION="${1:-status}"

# edit_conf <jq filter> [jq args...]: applies the filter to $CONF, validating the result before replacing it.
edit_conf() {
  local tmp
  tmp="$(mktemp)"
  if sudo cat "$CONF" | jq "$@" > "$tmp" && jq -e . "$tmp" > /dev/null 2>&1; then
    sudo install -m 0644 "$tmp" "$CONF"
    rm -f "$tmp"
  else
    rm -f "$tmp"
    echo "FAIL: could not edit $CONF safely; it was left unchanged." >&2
    exit 1
  fi
}

current() { [ -f "$CONF" ] && sudo jq -r '(.["registry-mirrors"] // []) | join(", ")' "$CONF" || true; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
firewall_ok() { sudo bash "$HERE/apply-sandbox-firewall.sh" status > /dev/null 2>&1; }

restart_docker() {
  [ "${SKIP_RESTART:-0}" = "1" ] && { echo "(restart skipped)"; return 0; }
  local had_firewall=0
  firewall_ok && had_firewall=1

  sudo systemctl restart docker
  for _ in $(seq 1 30); do
    sudo docker info > /dev/null 2>&1 && break
    sleep 1
  done
  sudo docker info > /dev/null 2>&1 || { echo "FAIL: Docker did not come back. See: sudo journalctl -u docker -n 50 --no-pager" >&2; exit 1; }
  echo "Docker restarted."

  # Restarting Docker also stops the firewall unit (it depends on Docker) and Docker rebuilds its own
  # iptables chains, so the sandbox rules are gone afterwards. Put them back explicitly, then check.
  if [ "$had_firewall" = "1" ] || systemctl is-enabled live-sandbox-firewall.service > /dev/null 2>&1; then
    if systemctl cat live-sandbox-firewall.service > /dev/null 2>&1; then
      sudo systemctl restart live-sandbox-firewall.service || true
    fi
    firewall_ok || sudo bash "$HERE/apply-sandbox-firewall.sh" apply > /dev/null
    if firewall_ok; then
      echo "Sandbox firewall re-applied."
    else
      echo "WARNING: the sandbox firewall is NOT installed. Run: sudo bash scripts/apply-sandbox-firewall.sh apply" >&2
    fi
  fi
}

case "$ACTION" in
  on)
    [ -f "$CONF" ] || echo '{}' | sudo tee "$CONF" > /dev/null
    edit_conf --arg m "$MIRROR" '.["registry-mirrors"] = (((.["registry-mirrors"] // []) + [$m]) | unique)'
    echo "Registry mirror ON: $(current)"
    restart_docker
    ;;
  off)
    [ -f "$CONF" ] || { echo "No $CONF; nothing to do."; exit 0; }
    edit_conf --arg m "$MIRROR" '.["registry-mirrors"] = ((.["registry-mirrors"] // []) - [$m]) | if (.["registry-mirrors"] | length) == 0 then del(.["registry-mirrors"]) else . end'
    echo "Registry mirror OFF."
    restart_docker
    ;;
  status)
    CURRENT="$(current)"
    echo "registry-mirrors: ${CURRENT:-none}"
    ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
