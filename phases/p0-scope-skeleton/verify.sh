#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; exit 1; }

echo "== Phase 0 verify: pnpm install =="
pnpm install --frozen-lockfile=false > /tmp/p0-install.log 2>&1 \
  && pass "pnpm install" \
  || { cat /tmp/p0-install.log; fail "pnpm install"; }

echo "== Phase 0 verify: build all 3 packages =="
pnpm run build > /tmp/p0-build.log 2>&1 \
  && pass "pnpm build (shared-types, streaming, web)" \
  || { cat /tmp/p0-build.log; fail "pnpm build"; }

echo "== Phase 0 verify: no 'any' in shared-types =="
if grep -RIn --include='*.ts' -E '\bany\b' packages/shared-types/src; then
  fail "found 'any' in packages/shared-types/src"
else
  pass "no 'any' in packages/shared-types/src"
fi

echo "== Phase 0 verify: docker-compose config is valid =="
docker compose config > /tmp/p0-compose.log 2>&1 \
  && pass "docker compose config" \
  || { cat /tmp/p0-compose.log; fail "docker compose config"; }

echo "== Phase 0 verify: streaming build artifact exists =="
[ -f packages/streaming/dist/server.js ] \
  && pass "packages/streaming/dist/server.js" \
  || fail "missing packages/streaming/dist/server.js"

echo "== Phase 0 verify: web build artifact exists =="
[ -d packages/web/dist ] && [ -n "$(ls -A packages/web/dist 2>/dev/null)" ] \
  && pass "packages/web/dist" \
  || fail "missing/empty packages/web/dist"

echo
echo "All Phase 0 checks passed."
echo "Manual step still required: run 'docker compose up', open"
echo "http://localhost:5173/host in one tab and http://localhost:5173/viewer"
echo "in another, and confirm the viewer receives live state updates from the host."
