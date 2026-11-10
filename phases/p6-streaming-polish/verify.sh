#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
note() { echo "  NOTE: $1"; }
fail() {
  echo "  FAIL: $1"
  if [ -n "${STREAMING_LOG:-}" ] && [ -f "$STREAMING_LOG" ]; then
    echo "  --- last lines of the streaming server log ($STREAMING_LOG) ---"
    tail -n 30 "$STREAMING_LOG" || true
  fi
  exit 1
}

for tool in docker curl node pnpm; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required to run Phase 6 verification but was not found on PATH"
done

STREAMING_PORT="${P6_STREAMING_PORT:-4012}"
STREAMING_URL="http://127.0.0.1:${STREAMING_PORT}"
LOG_DIR="$(mktemp -d /tmp/p6-verify.XXXXXX)"
STREAMING_LOG="$LOG_DIR/streaming.log"
STREAMING_PID=""

streaming_alive() { [ -n "$STREAMING_PID" ] && kill -0 "$STREAMING_PID" 2> /dev/null; }

cleanup() {
  if streaming_alive; then
    kill "$STREAMING_PID" 2> /dev/null || true
    wait "$STREAMING_PID" 2> /dev/null || true
  fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# 1. Regression: Phase 5 (which re-runs Phases 0-4).
# --------------------------------------------------------------------------
echo "== Phase 6 verify: Phase 5 regression suite (includes Phases 0-4) =="
bash phases/p5-orchestration/verify.sh
pass "Phase 5 regression suite (orchestration / control plane, and everything under it)"
echo

echo "== Phase 6 verify: pnpm install =="
pnpm install --frozen-lockfile=false > "$LOG_DIR/install.log" 2>&1 \
  && pass "pnpm install" \
  || { cat "$LOG_DIR/install.log"; fail "pnpm install"; }
echo

echo "== Phase 6 verify: build all packages (shared-types, streaming, orchestrator, web) =="
pnpm run build > "$LOG_DIR/build.log" 2>&1 \
  && pass "pnpm build" \
  || { cat "$LOG_DIR/build.log"; fail "pnpm build"; }
for artifact in \
  packages/streaming/dist/server.js \
  packages/streaming/dist/rateLimiter.js \
  packages/streaming/dist/socket/hostHandlers.js \
  packages/streaming/dist/socket/viewerHandlers.js; do
  [ -f "$artifact" ] || fail "$artifact missing after build"
done
pass "Phase 6 streaming modules were compiled (rateLimiter, hostHandlers, viewerHandlers)"
pnpm run lint:no-any > "$LOG_DIR/lint.log" 2>&1 \
  && pass "shared-types still has no 'any' (the new editor-sync events included)" \
  || { cat "$LOG_DIR/lint.log"; fail "lint:no-any found an 'any' in shared-types"; }
echo

# --------------------------------------------------------------------------
# 2. Boot a dedicated streaming server from the compiled output.
#    (The docker compose 'streaming' service on :4000 is left untouched.)
# --------------------------------------------------------------------------
echo "== Phase 6 verify: start the streaming server on :${STREAMING_PORT} =="
if curl -sf -m 2 "${STREAMING_URL}/health" > /dev/null 2>&1; then
  fail "something is already answering on ${STREAMING_URL}; set P6_STREAMING_PORT to a free port"
fi
(
  cd "$REPO_ROOT"
  exec env PORT="$STREAMING_PORT" WEB_ORIGIN="http://localhost:5173" \
    node packages/streaming/dist/server.js
) >> "$STREAMING_LOG" 2>&1 &
STREAMING_PID=$!

ready=0
for _ in $(seq 1 30); do
  if ! streaming_alive; then
    fail "streaming server exited during startup"
  fi
  if curl -sf -m 2 "${STREAMING_URL}/health" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail "streaming server never answered /health on ${STREAMING_URL}"
pass "streaming server healthy at ${STREAMING_URL}"
echo

# --------------------------------------------------------------------------
# 3. Protocol checks with real Socket.IO clients:
#    limiter guarantees, <2s resync, <=10Hz caret stream, 50 viewers.
# --------------------------------------------------------------------------
echo "== Phase 6 verify: streaming protocol (resync, 10Hz cursor limit, 50 viewers) =="
STREAMING_URL="$STREAMING_URL" node phases/p6-streaming-polish/streamingCheck.mjs \
  || fail "streaming protocol checks failed (see the output above)"
pass "streaming protocol checks"
echo

streaming_alive || fail "streaming server died while the checks were running"
pass "streaming server survived the whole run"
echo

note "The web components (CursorOverlay, ShareLink) are compile-checked by 'pnpm build' above."
note "HostPage/ViewerPage do not emit or consume the new events yet, so the browser UI is not exercised here."
note "Heartbeats from the host UI to the orchestrator (Phase 5 note) are not part of this phase's file list."
echo "All Phase 6 checks passed."