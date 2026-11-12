#!/usr/bin/env bash
# Prepares a fresh Ubuntu 22.04/24.04 machine (x86_64 or arm64, e.g. a Multipass VM)
# to run every phase gate through Phase 7. Safe to run again: each step checks first.
#
#   bash scripts/setup-linux-host.sh
#
# What it installs / changes (all with sudo):
#   - Docker Engine + compose plugin from Docker's apt repository (removes the snap build)
#   - gVisor (runsc) from gVisor's apt repository, registered with Docker
#   - "dns": public resolvers in /etc/docker/daemon.json, because the sandbox firewall
#     blocks private address ranges and a VM's own resolver is usually one of them
#   - Node.js 20 and pnpm 9 (corepack), plus a C++ toolchain for node-pty
#   - br_netfilter + sysctl persisted across reboots
#   - a systemd unit that re-applies the sandbox firewall after every boot
# It does NOT start any project containers.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n== %s ==\n' "$1"; }

[ "$(uname -s)" = "Linux" ] || { echo "This script is for Linux (use a Multipass Ubuntu VM on a Mac)." >&2; exit 1; }
[ "$(id -u)" != "0" ] || { echo "Run it as your normal user (it uses sudo itself)." >&2; exit 1; }
# On Ubuntu cloud images "sudo -v" asks for a password even though commands are passwordless
# (and the default user has no password), so only fall back to it if sudo really needs one.
sudo -n true 2> /dev/null || sudo -v
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in ubuntu | debian) ;; *) echo "Only Ubuntu/Debian are handled (found: ${ID:-unknown})." >&2; exit 1 ;; esac
ARCH="$(dpkg --print-architecture)"

say "Base packages"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg jq iptables git build-essential python3 apt-transport-https

say "Docker Engine"
if snap list docker > /dev/null 2>&1; then
  echo "Removing the snap Docker (it breaks gVisor and bind mounts)..."
  sudo snap remove --purge docker
fi
if ! command -v docker > /dev/null 2>&1 || ! docker compose version > /dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Docker already installed: $(docker --version)"
fi
sudo systemctl enable --now docker
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  NEED_RELOGIN=1
fi

say "gVisor (runsc)"
if ! command -v runsc > /dev/null 2>&1; then
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y runsc
fi
if ! sudo docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  sudo runsc install
fi
# Public DNS for containers, only if the operator has not chosen resolvers already.
if [ -f /etc/docker/daemon.json ] && ! sudo jq -e 'has("dns")' /etc/docker/daemon.json > /dev/null; then
  TMP_JSON="$(mktemp)"
  sudo cat /etc/docker/daemon.json | jq '. + {"dns": ["1.1.1.1", "8.8.8.8"]}' > "$TMP_JSON" && jq -e . "$TMP_JSON" > /dev/null \
    || { echo "Could not edit /etc/docker/daemon.json safely; left unchanged." >&2; exit 1; }
  sudo install -m 0644 "$TMP_JSON" /etc/docker/daemon.json
  rm -f "$TMP_JSON"
  echo "Added public DNS resolvers to /etc/docker/daemon.json"
fi
sudo systemctl restart docker
sudo docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || { echo "runsc is still not registered with Docker" >&2; exit 1; }
echo "runsc registered: $(runsc --version 2> /dev/null | head -n 1)"

say "Node.js 20 and pnpm"
if ! command -v node > /dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
corepack prepare pnpm@9.0.0 --activate
echo "node $(node -v), pnpm $(pnpm -v)"

say "Bridge netfilter (persisted)"
echo br_netfilter | sudo tee /etc/modules-load.d/live-sandbox.conf > /dev/null
echo "net.bridge.bridge-nf-call-iptables = 1" | sudo tee /etc/sysctl.d/99-live-sandbox.conf > /dev/null
sudo modprobe br_netfilter
sudo sysctl -q --system

say "Sandbox firewall at boot"
sudo tee /etc/systemd/system/live-sandbox-firewall.service > /dev/null << UNIT
[Unit]
Description=Live sandbox firewall rules
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/env bash ${REPO_ROOT}/scripts/apply-sandbox-firewall.sh apply
ExecStop=/usr/bin/env bash ${REPO_ROOT}/scripts/apply-sandbox-firewall.sh remove

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable live-sandbox-firewall.service
sudo systemctl restart live-sandbox-firewall.service   # explicit, so a re-run always re-applies the rules
sudo bash "${REPO_ROOT}/scripts/apply-sandbox-firewall.sh" status

say "Done"
if [ "${NEED_RELOGIN:-0}" = "1" ]; then
  echo "You were added to the 'docker' group. Log out and back in (exit, then 'multipass shell <name>')"
  echo "before running anything else, or Docker will say 'permission denied'."
fi
echo "Next: bash scripts/doctor.sh   (then: bash scripts/prefetch-images.sh)"
