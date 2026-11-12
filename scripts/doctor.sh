#!/usr/bin/env bash
# Checks that this machine can run the phase gates that need real containers
# (Phases 1-7). Read-only: it installs nothing. Exit 0 = ready, 1 = a blocker.
#
#   bash scripts/doctor.sh
#
# FAIL lines are blockers. WARN lines are things that usually bite later.
# scripts/setup-linux-host.sh fixes most FAILs on Ubuntu.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# shellcheck source=scripts/lib/docker-net.sh
. scripts/lib/docker-net.sh

FAILS=0
ok() { echo "  ok:   $1"; }
warn() { echo "  WARN: $1"; }
bad() {
  echo "  FAIL: $1"
  [ -n "${2:-}" ] && echo "        -> $2"
  FAILS=$((FAILS + 1))
}

echo "== host doctor =="

# --- operating system -------------------------------------------------------
if [ "$(uname -s)" != "Linux" ]; then
  bad "this is $(uname -s), not Linux" \
    "gVisor (Phase 7) only runs on Linux. On a Mac, run everything inside a Multipass Ubuntu VM (docs/PHASE-7-RUNBOOK.md)."
  echo
  echo "doctor: $FAILS blocker(s)"
  exit 1
fi
ok "Linux $(uname -r) on $(uname -m)"

# --- docker ----------------------------------------------------------------
if ! command -v docker > /dev/null 2>&1; then
  bad "docker is not installed" "run: bash scripts/setup-linux-host.sh"
else
  if [ "$(command -v docker)" = "/snap/bin/docker" ] || snap list docker > /dev/null 2>&1; then
    bad "Docker is the snap package" \
      "the snap build cannot read most paths and breaks gVisor and compose; run: sudo snap remove --purge docker && bash scripts/setup-linux-host.sh"
  fi
  INFO_ERR="$(docker info 2>&1 > /dev/null || true)"
  if docker info > /dev/null 2>&1; then
    ok "docker daemon reachable ($(docker version --format '{{.Server.Version}}' 2> /dev/null))"
  elif echo "$INFO_ERR" | grep -qi "permission denied"; then
    bad "permission denied talking to the Docker daemon" \
      "run: sudo usermod -aG docker \$USER  then log out and back in (or: newgrp docker)"
  elif echo "$INFO_ERR" | grep -qiE "cannot connect|is the docker daemon running"; then
    bad "the Docker daemon is not running" \
      "run: sudo systemctl enable --now docker   (then: journalctl -u docker -n 50 --no-pager)"
  else
    bad "docker info failed: ${INFO_ERR:-unknown error}"
  fi
  docker compose version > /dev/null 2>&1 \
    && ok "docker compose v2 plugin present" \
    || bad "docker compose v2 plugin missing" "sudo apt-get install -y docker-compose-plugin"
fi

# --- resources (the Multipass default VM is 1 CPU / 1 GB RAM / 5 GB disk) --------
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
if [ "$MEM_MB" -lt 3500 ]; then
  bad "only ${MEM_MB} MB of RAM" "give the VM at least 4 GB (multipass set local.<name>.memory=6G after multipass stop)"
else
  ok "${MEM_MB} MB RAM"
fi
CPUS="$(nproc)"
[ "$CPUS" -ge 2 ] && ok "$CPUS CPUs" || warn "$CPUS CPU: the 50-viewer test and image builds will be slow (use 2+)"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2> /dev/null || echo /var/lib/docker)"
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT=/
FREE_GB="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {printf "%d", $4/1048576}')"
if [ "$FREE_GB" -lt 8 ]; then
  bad "only ${FREE_GB} GB free for Docker images" "give the VM 30+ GB (multipass set local.<name>.disk=40G after multipass stop)"
else
  ok "${FREE_GB} GB free for Docker"
fi

# --- registry access ---------------------------------------------------------
# The gates pull images from Docker Hub. A flaky path to it ("TLS handshake timeout") makes
# builds fail in confusing places, so check it first and say plainly what is wrong.
probe() { # probe <url> [extra curl args]: prints a summary, returns 0 if the registry answered
  local url="$1" out rc
  shift
  out="$(curl -sS -m 15 -o /dev/null -w '%{http_code} tcp=%{time_connect}s tls=%{time_appconnect}s' "$@" "$url" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ] && echo "$out" | grep -qE '^(200|401) '; then
    echo "answered ($out)"
    return 0
  fi
  echo "no answer (curl exit $rc: $(echo "$out" | tail -n 1))"
  return 1
}
LOCAL_IMAGE=""
if docker info > /dev/null 2>&1; then
  MISSING=()
  for img in "${REQUIRED_IMAGES[@]}"; do
    docker image inspect "$img" > /dev/null 2>&1 || MISSING+=("$img")
  done
  for img in alpine:3 node:20-bookworm redis:7-alpine; do
    if docker image inspect "$img" > /dev/null 2>&1; then
      LOCAL_IMAGE="$img"
      break
    fi
  done
  if [ "${#MISSING[@]}" -eq 0 ]; then
    ok "all ${#REQUIRED_IMAGES[@]} required images are already on this machine"
  else
    # One lucky request proves nothing (a single curl succeeded while every docker pull failed), so
    # require repeated success from both the HTTP path and the resolver.
    HUB_OK=0 DNS_OK=0
    for _ in 1 2 3; do
      probe https://registry-1.docker.io/v2/ > /dev/null && HUB_OK=$((HUB_OK + 1))
      getent ahosts registry-1.docker.io > /dev/null 2>&1 && DNS_OK=$((DNS_OK + 1))
    done
    if [ "$HUB_OK" -eq 3 ] && [ "$DNS_OK" -eq 3 ]; then
      warn "missing images: ${MISSING[*]}; Docker Hub answered 3/3, so run: bash scripts/prefetch-images.sh"
    else
      echo "        Docker Hub answered $HUB_OK/3 requests; DNS lookups succeeded $DNS_OK/3"
      echo "        last request: $(probe https://registry-1.docker.io/v2/)"
      if [ "$(ip -6 route show default 2> /dev/null | wc -l)" -gt 0 ]; then
        echo "        this VM has an IPv6 default route (a common cause of 'TLS handshake timeout' on NAT networks)"
      fi
      bad "Docker Hub is unreliable from this machine (missing images: ${MISSING[*]})" \
        "run: bash scripts/diagnose-network.sh --apply   (measures DNS, IPv6 and MTU and fixes what it finds), then: bash scripts/prefetch-images.sh"
    fi
  fi
fi

# --- gVisor ----------------------------------------------------------------
if docker info > /dev/null 2>&1; then
  if docker info --format '{{json .Runtimes}}' 2> /dev/null | grep -q '"runsc"'; then
    ok "runtime runsc is registered with Docker"
    # Registered is not the same as working: start a real container under it. Uses an image that is
    # already on disk, so a registry problem can never be mistaken for a gVisor problem.
    if [ -z "$LOCAL_IMAGE" ]; then
      bad "cannot confirm gVisor works: no base image is on this machine yet" \
        "fix registry access above, then: bash scripts/prefetch-images.sh && bash scripts/doctor.sh"
    else
      HOST_KERNEL="$(uname -r)"
      if SEEN="$(docker run --rm --runtime=runsc --network none --entrypoint cat "$LOCAL_IMAGE" /proc/version 2>&1)"; then
        if echo "$SEEN" | grep -qF "$HOST_KERNEL"; then
          bad "a container under runsc sees the HOST kernel ($HOST_KERNEL)" "it is not really running under gVisor; check /etc/docker/daemon.json"
        else
          ok "a container really starts under runsc and sees gVisor's kernel ($LOCAL_IMAGE)"
        fi
      else
        REAL="$(echo "$SEEN" | grep -vE '^$|docker run --help' | tail -n 3 | tr '\n' ' ')"
        bad "a container would not start under runsc: $REAL" \
          "check: sudo journalctl -u docker -n 50 --no-pager ; ls /usr/bin/runsc /usr/bin/containerd-shim-runsc-v1"
      fi
    fi
  else
    bad "runtime runsc (gVisor) is not registered with Docker" "run: bash scripts/setup-linux-host.sh"
  fi
fi

# --- firewall -------------------------------------------------------------
BNF="$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2> /dev/null || echo missing)"
[ "$BNF" = "1" ] && ok "bridge netfilter is on" || warn "bridge netfilter is $BNF; 'apply-sandbox-firewall.sh apply' turns it on"
if [ "$(id -u)" = "0" ] || sudo -n true 2> /dev/null; then
  if sudo -n bash scripts/apply-sandbox-firewall.sh status > /dev/null 2>&1 || bash scripts/apply-sandbox-firewall.sh status > /dev/null 2>&1; then
    ok "sandbox firewall rules are installed"
  else
    warn "sandbox firewall rules are NOT installed (run Phase 7 with P7_APPLY_FIREWALL=1, or: sudo bash scripts/apply-sandbox-firewall.sh apply)"
  fi
else
  warn "no root/sudo here, so the firewall state cannot be checked"
fi

# --- toolchain -------------------------------------------------------------
if command -v node > /dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] && ok "node $(node -v)" || bad "node $(node -v) is too old" "Node 20+ is required"
else
  bad "node is not installed" "bash scripts/setup-linux-host.sh"
fi
command -v pnpm > /dev/null 2>&1 && ok "pnpm $(pnpm -v)" || bad "pnpm is not installed" "sudo corepack enable && corepack prepare pnpm@9.0.0 --activate"
command -v curl > /dev/null 2>&1 && ok "curl present" || bad "curl is not installed" "sudo apt-get install -y curl"
command -v g++ > /dev/null 2>&1 && command -v make > /dev/null 2>&1 \
  && ok "C++ toolchain present (node-pty compiles on install)" \
  || warn "no g++/make: 'pnpm install' will fail building node-pty (sudo apt-get install -y build-essential python3)"

# --- ports -----------------------------------------------------------------
for port in 80 8080 6379; do
  if ss -ltn 2> /dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
    OWNER="$(docker ps --format '{{.Names}} {{.Ports}}' 2> /dev/null | grep -E ":${port}->" | awk '{print $1}' | head -n 1)"
    if [ -n "$OWNER" ]; then
      ok "port $port is in use by the compose container $OWNER (expected)"
    else
      warn "port $port is already in use by something that is not Docker; the gates need it"
    fi
  fi
done

echo
if [ "$FAILS" -gt 0 ]; then
  echo "doctor: $FAILS blocker(s). Fix them and run this again."
  exit 1
fi
echo "doctor: ready."
