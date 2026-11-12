#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables here are consumed by the scripts that source this file
# Shared by scripts/doctor.sh and scripts/prefetch-images.sh. Source it; do not run it.

# Images the gates pull from a registry (through Phase 7). Keep in sync with
# docker-compose.yml and packages/sandbox-agent/Dockerfile.sandbox-base.
REQUIRED_IMAGES=(node:20-bookworm node:20-bookworm-slim redis:7-alpine traefik:v3.1 alpine:3)
# Only the production compose file (Phase 8) uses these.
OPTIONAL_IMAGES=(nginx:1.27-alpine postgres:16-alpine)

# explain_pull_error "<docker output>": prints a one-line cause and what to do about it.
explain_pull_error() {
  local text="$1"
  if echo "$text" | grep -qiE "toomanyrequests|rate limit"; then
    echo "Docker Hub rate limit for anonymous pulls (common behind shared/CGNAT addresses). Run: docker login"
  elif echo "$text" | grep -qiE "x509|certificate (has expired|is not yet valid)"; then
    echo "TLS certificate rejected; the VM clock is probably wrong. Check: timedatectl ; fix: sudo systemctl restart systemd-timesyncd"
  elif echo "$text" | grep -qiE "no such host|temporary failure in name resolution|server misbehaving"; then
    echo "DNS lookups on the VM are failing (the resolver, not the registry). Run: bash scripts/diagnose-network.sh --apply"
  elif echo "$text" | grep -qiE "tls handshake timeout|i/o timeout|context deadline exceeded|timed out|connection reset"; then
    echo "the network path to the registry drops packets or is unreliable. Run: bash scripts/diagnose-network.sh --apply   (it measures DNS, IPv6 and MTU and fixes what it finds)"
  elif echo "$text" | grep -qiE "connection refused|network is unreachable|no route to host"; then
    echo "the VM has no route to the registry. Check: ping -c1 1.1.1.1 ; ip route"
  else
    echo "unrecognised pull error (see the text above)"
  fi
}

# docker_pull_retry <image> [attempts]: pull with backoff. Output of the last failure is left in $PULL_LOG.
PULL_LOG=""
docker_pull_retry() {
  local image="$1" attempts="${2:-5}" n=1
  while [ "$n" -le "$attempts" ]; do
    if PULL_LOG="$(docker pull "$image" 2>&1)"; then
      return 0
    fi
    [ "$n" -lt "$attempts" ] && sleep $((n * 5))
    n=$((n + 1))
  done
  return 1
}
