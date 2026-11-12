#!/usr/bin/env bash
# PARTIAL Phase 7 check that needs only Node and pnpm: no Docker, no gVisor, no Linux.
# Runs on a Mac. It proves the authentication and ownership half of Phase 7 and
# NOTHING about the sandbox. It does not lock Phase 7: only phases/p7-security/verify.sh does.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

for tool in node pnpm; do
  command -v "$tool" > /dev/null 2>&1 || { echo "FAIL: $tool is required" >&2; exit 1; }
done

echo "== install (native build scripts skipped: nothing here needs node-pty) =="
CI=true pnpm install --frozen-lockfile=false --ignore-scripts > /tmp/p7-auth-only-install.log 2>&1 \
  || { cat /tmp/p7-auth-only-install.log; echo "FAIL: pnpm install" >&2; exit 1; }
echo "== build shared-types and orchestrator =="
pnpm --filter @live/shared-types --filter @live/orchestrator run build
echo "== authentication and ownership checks =="
node phases/p7-security/authCheck.mjs

echo
echo "PARTIAL PASS: authentication, tokens, 401s, ownership, session cap, schema v2."
echo "NOT checked here: gVisor runtime, pty under gVisor, network isolation, firewall, the real"
echo "end-to-end run. Those need Linux + Docker + gVisor: see docs/PHASE-7-RUNBOOK.md."
