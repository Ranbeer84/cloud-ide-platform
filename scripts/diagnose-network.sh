#!/usr/bin/env bash
# Finds out WHY Docker image pulls fail on this machine, by measuring instead of guessing:
#   1. DNS      repeated lookups of the registry hosts through the VM's resolver
#   2. IPv6     whether the VM has an IPv6 route and whether it actually works to the registry
#   3. IPv4     repeated TLS requests to the registry (a single success proves nothing)
#   4. MTU      the largest packet that crosses the network without fragmenting
# and names the cause. It changes nothing unless you pass --apply.
#
#   bash scripts/diagnose-network.sh            # measure and explain
#   bash scripts/diagnose-network.sh --apply    # also apply the fix for each cause found, then re-measure
#
# Fixes it can apply (each is small, persistent where noted, and reversible):
#   DNS   systemd-resolved drop-in adding public resolvers   (10-live-dns.conf)
#   IPv6  sysctl drop-in disabling IPv6 on this VM           (99-live-no-ipv6.conf)
#   MTU   lowers the interface MTU now (resets on reboot; run this script again)
# Docker is never restarted here, so the sandbox firewall is not disturbed.
set -uo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
ETC="${LIVE_ETC:-/etc}"
TRIES="${DIAG_TRIES:-5}"
HOSTS=(registry-1.docker.io auth.docker.io production.cloudflare.docker.com mirror.gcr.io)
REGISTRY_URL="https://registry-1.docker.io/v2/"
SUDO=""
[ "$(id -u)" != "0" ] && SUDO="sudo"

say() { printf '\n== %s ==\n' "$1"; }

# ---- measurements (functions so they can be repeated after a fix) -----------------

# Sets DNS_FAILED (lookups that failed) and DNS_TOTAL.
measure_dns() {
  DNS_FAILED=0
  DNS_TOTAL=0
  DNS_BAD_HOSTS=()
  local h n failed
  for h in "${HOSTS[@]}"; do
    failed=0
    for n in $(seq 1 "$TRIES"); do
      : "$n"
      getent ahosts "$h" > /dev/null 2>&1 || failed=$((failed + 1))
    done
    printf '  %-36s %s/%s lookups succeeded\n' "$h" "$((TRIES - failed))" "$TRIES"
    DNS_FAILED=$((DNS_FAILED + failed))
    DNS_TOTAL=$((DNS_TOTAL + TRIES))
    [ "$failed" -gt 0 ] && DNS_BAD_HOSTS+=("$h")
  done
}

# fetch_ok <curl family flag>: echoes "<ok>/<TRIES> avg-tls-seconds"
fetch_ok() {
  local flag="$1" ok=0 total_t=0 n out code t
  for n in $(seq 1 "$TRIES"); do
    : "$n"
    out="$(curl "$flag" -sS -m 15 -o /dev/null -w '%{http_code} %{time_appconnect}' "$REGISTRY_URL" 2> /dev/null)" || out="000 0"
    code="${out%% *}"
    t="${out##* }"
    if [ "$code" = "200" ] || [ "$code" = "401" ]; then
      ok=$((ok + 1))
      total_t="$(awk -v a="$total_t" -v b="$t" 'BEGIN {print a + b}')"
    fi
  done
  if [ "$ok" -gt 0 ]; then
    echo "$ok/$TRIES avg-tls=$(awk -v a="$total_t" -v n="$ok" 'BEGIN {printf "%.2fs", a / n}')"
  else
    echo "0/$TRIES"
  fi
}

# ---- 1. DNS --------------------------------------------------------------------
say "1. DNS (through this VM's resolver)"
UPSTREAM="$(resolvectl dns 2> /dev/null | tr '\n' ' ' | sed 's/  */ /g')"
[ -n "$UPSTREAM" ] && echo "  resolver upstreams: $UPSTREAM"
measure_dns

# ---- 2. IPv6 -------------------------------------------------------------------
say "2. IPv6"
V6_ADDR="$(ip -6 addr show scope global 2> /dev/null | awk '/inet6/ {print $2}' | head -n 1)"
V6_ROUTE="$(ip -6 route show default 2> /dev/null | head -n 1)"
V6_RESULT="n/a"
if [ -z "$V6_ROUTE" ]; then
  echo "  no IPv6 default route${V6_ADDR:+ (address $V6_ADDR is local-only)}: IPv6 is not in play"
else
  echo "  IPv6 address ${V6_ADDR:-none}, default route: $V6_ROUTE"
  V6_RESULT="$(fetch_ok -6)"
  echo "  registry over IPv6: $V6_RESULT"
fi

# ---- 3. IPv4 -------------------------------------------------------------------
say "3. Registry over IPv4"
V4_RESULT="$(fetch_ok -4)"
echo "  registry over IPv4: $V4_RESULT"

# ---- 4. MTU --------------------------------------------------------------------
say "4. Path MTU"
DEF_IF="$(ip -4 route show default 2> /dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}')"
IF_MTU="${DIAG_IF_MTU:-$(cat "/sys/class/net/${DEF_IF:-none}/mtu" 2> /dev/null || echo 1500)}"
LARGEST=0
for size in 1472 1452 1432 1400 1372 1300 1200; do
  if ping -4 -c 1 -W 3 -M "do" -s "$size" 1.1.1.1 > /dev/null 2>&1; then
    LARGEST="$size"
    break
  fi
done
PATH_MTU=0
if [ "$LARGEST" -gt 0 ]; then
  PATH_MTU=$((LARGEST + 28))
  echo "  interface ${DEF_IF:-?} MTU $IF_MTU; largest unfragmented packet to 1.1.1.1: $PATH_MTU"
else
  echo "  interface ${DEF_IF:-?} MTU $IF_MTU; ping got no reply (ICMP may be filtered), so MTU cannot be judged"
fi

# ---- 5. other things that commonly interfere -------------------------------------
say "5. Other"
PROXY_ENV="$( (env; systemctl show docker --property=Environment 2> /dev/null) | grep -i proxy | head -n 3)"
[ -n "$PROXY_ENV" ] && echo "  proxy settings present: $PROXY_ENV" || echo "  no proxy settings"
MIRRORS=""
[ -f "$ETC/docker/daemon.json" ] && MIRRORS="$(jq -r '(.["registry-mirrors"] // []) | join(", ")' "$ETC/docker/daemon.json" 2> /dev/null)"
[ -n "$MIRRORS" ] && echo "  Docker registry mirrors configured: $MIRRORS" || echo "  no Docker registry mirror configured"

# ---- verdict ---------------------------------------------------------------------
say "Verdict"
CAUSES=()
[ "$DNS_FAILED" -gt 0 ] && CAUSES+=(dns)
if [ -n "$V6_ROUTE" ] && [ "${V6_RESULT%%/*}" != "$TRIES" ]; then
  CAUSES+=(ipv6)
fi
# Only a problem if the interface promises more than the path carries. An interface already set
# below 1500 also makes the 1472-byte ping fail locally, which is not a fault.
if [ "$PATH_MTU" -gt 0 ] && [ "$PATH_MTU" -lt "$IF_MTU" ]; then
  CAUSES+=(mtu)
fi
V4_OK="${V4_RESULT%%/*}"
if [ "${#CAUSES[@]}" -eq 0 ] && [ "$V4_OK" -lt "$TRIES" ]; then
  CAUSES+=(flaky)
fi

if [ "${#CAUSES[@]}" -eq 0 ]; then
  echo "  No problem found right now: DNS, IPv6 and IPv4 all behaved on every try."
  echo "  If a pull still fails, it was intermittent: run  bash scripts/prefetch-images.sh  (it retries)."
  exit 0
fi

for cause in "${CAUSES[@]}"; do
  case "$cause" in
    dns)
      echo "  - DNS is unreliable: $DNS_FAILED of $DNS_TOTAL lookups failed (${DNS_BAD_HOSTS[*]})."
      echo "    The VM's resolver forwards to the Mac's network, which is dropping some queries."
      echo "    Fix: add public resolvers to systemd-resolved."
      if [ -n "$MIRRORS" ] && printf '%s\n' "${DNS_BAD_HOSTS[@]}" | grep -q mirror.gcr.io; then
        echo "    Also: a registry mirror is configured and its name fails to resolve, which makes pulls fail."
        echo "    Turn it off until DNS is stable: bash scripts/use-registry-mirror.sh off"
      fi
      ;;
    ipv6)
      echo "  - IPv6 is configured but unreliable to the registry (${V6_RESULT} vs IPv4 ${V4_RESULT})."
      echo "    Connections that pick IPv6 connect and then stall, which shows up as 'TLS handshake timeout'."
      echo "    Fix: disable IPv6 on this VM."
      ;;
    mtu)
      echo "  - Packets larger than $PATH_MTU bytes do not get through, but the interface MTU is $IF_MTU."
      echo "    Large TLS handshakes are silently dropped, which shows up as 'TLS handshake timeout'."
      echo "    Fix: lower the interface MTU to $PATH_MTU."
      ;;
    flaky)
      echo "  - IPv4 requests to the registry failed ($V4_RESULT) while DNS, IPv6 and MTU look fine."
      echo "    That points at the upstream connection itself (Wi-Fi, hotspot, ISP routing to the registry's CDN)."
      echo "    There is no local fix. Try another network, wait and retry, or: bash scripts/use-registry-mirror.sh on"
      ;;
  esac
done

if [ "$APPLY" != "1" ]; then
  echo
  echo "  Nothing was changed. To apply the fixes above: bash scripts/diagnose-network.sh --apply"
  exit 1
fi

# ---- apply ------------------------------------------------------------------------
say "Applying"
for cause in "${CAUSES[@]}"; do
  case "$cause" in
    dns)
      $SUDO mkdir -p "$ETC/systemd/resolved.conf.d"
      printf '[Resolve]\nDNS=1.1.1.1 8.8.8.8\nFallbackDNS=1.0.0.1 8.8.4.4\n' | $SUDO tee "$ETC/systemd/resolved.conf.d/10-live-dns.conf" > /dev/null
      $SUDO systemctl restart systemd-resolved 2> /dev/null || echo "  (could not restart systemd-resolved)"
      echo "  DNS: added public resolvers ($ETC/systemd/resolved.conf.d/10-live-dns.conf). Undo: delete that file and restart systemd-resolved."
      ;;
    ipv6)
      printf 'net.ipv6.conf.all.disable_ipv6 = 1\nnet.ipv6.conf.default.disable_ipv6 = 1\n' | $SUDO tee "$ETC/sysctl.d/99-live-no-ipv6.conf" > /dev/null
      $SUDO sysctl -q -p "$ETC/sysctl.d/99-live-no-ipv6.conf" > /dev/null 2>&1 || echo "  (could not apply the sysctl now; it will apply at next boot)"
      echo "  IPv6: disabled ($ETC/sysctl.d/99-live-no-ipv6.conf). Undo: delete that file and reboot."
      ;;
    mtu)
      if [ -n "$DEF_IF" ] && [ "$PATH_MTU" -gt 0 ] && $SUDO ip link set dev "$DEF_IF" mtu "$PATH_MTU" 2> /dev/null; then
        echo "  MTU: $DEF_IF set to $PATH_MTU. This resets on reboot; run this script again afterwards."
      else
        echo "  MTU: could not change it; run: sudo ip link set dev ${DEF_IF:-<iface>} mtu ${PATH_MTU:-1400}"
      fi
      ;;
    flaky) echo "  (no local fix for an unreliable upstream connection)" ;;
  esac
done

say "Re-measuring"
sleep 2
measure_dns
if [ -n "$V6_ROUTE" ] && [[ " ${CAUSES[*]} " == *" ipv6 "* ]]; then
  echo "  IPv6 route now: $(ip -6 route show default 2> /dev/null | head -n 1 || true)"
  [ -z "$(ip -6 route show default 2> /dev/null)" ] && echo "  (IPv6 default route is gone)"
fi
echo "  registry over IPv4: $(fetch_ok -4)"
if [ "$DNS_FAILED" -eq 0 ]; then
  echo
  echo "  Next: bash scripts/prefetch-images.sh"
  exit 0
fi
echo
echo "  DNS still fails after the fix. Run this script again; if it persists, the problem is upstream of this VM."
exit 1
