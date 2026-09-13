#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }

if ! command -v docker > /dev/null 2>&1; then
  fail "docker is required to run Phase 1 verification but was not found on PATH"
fi

echo "== Phase 1 verify: Phase 0 regression suite =="
bash phases/p0-scope-skeleton/verify.sh
pass "Phase 0 regression suite"
echo

echo "== Phase 1 verify: pnpm install =="
pnpm install --frozen-lockfile=false > /tmp/p1-install.log 2>&1 \
  && pass "pnpm install" \
  || { cat /tmp/p1-install.log; fail "pnpm install"; }
echo

echo "== Phase 1 verify: build all 6 packages =="
pnpm run build > /tmp/p1-build.log 2>&1 \
  && pass "pnpm build (shared-types, streaming, web, sandbox-agent, orchestrator)" \
  || { cat /tmp/p1-build.log; fail "pnpm build"; }
echo

echo "== Phase 1 verify: build sandbox base image =="
export SANDBOX_IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
./scripts/seed-sandbox-image.sh > /tmp/p1-image-build.log 2>&1 \
  && pass "docker build ${SANDBOX_IMAGE_TAG}" \
  || { cat /tmp/p1-image-build.log; fail "sandbox base image build"; }
echo

echo "== Phase 1 verify: container isolation, lifecycle, and 512MB OOM enforcement =="
echo "   (echo hello / cat /proc/1/cgroup / stopContainer / stress-ng OOM-kill)"
SANDBOX_IMAGE_TAG="$SANDBOX_IMAGE_TAG" node phases/p1-sandbox-execution/dockerIntegrationCheck.mjs
echo

echo "All Phase 1 checks passed."
