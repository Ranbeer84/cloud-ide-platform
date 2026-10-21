#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
note() { echo "  NOTE: $1"; }
fail() {
  echo "  FAIL: $1"
  if [ -n "${CURRENT_LOG:-}" ] && [ -f "$CURRENT_LOG" ]; then
    echo "  --- last lines of orchestrator log ($CURRENT_LOG) ---"
    tail -n 30 "$CURRENT_LOG" || true
  fi
  exit 1
}

for tool in docker curl node pnpm; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required to run Phase 5 verification but was not found on PATH"
done
docker compose version > /dev/null 2>&1 || fail "docker compose (v2 plugin) is required to run Phase 5 verification"

NETWORK_NAME="live-network"
SANDBOX_IMAGE_TAG="${SANDBOX_IMAGE_TAG:-live/sandbox-base:latest}"
ORCH_PORT="${P5_ORCH_PORT:-4101}"
ORCH_URL="http://127.0.0.1:${ORCH_PORT}"
REDIS_HOST_PORT="${REDIS_HOST_PORT:-6379}"
# Isolated key prefix so this run never touches real session data in Redis.
REDIS_PREFIX="live-p5-verify:"
GHOST_ID="p5-ghost"
ROGUE_NAME="p5-verify-orphan"
FAKE_CONTAINER_ID="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
LOG_DIR="$(mktemp -d /tmp/p5-verify.XXXXXX)"

ORCH_PID=""
CURRENT_LOG=""
CREATED_SESSIONS=""
HTTP_STATUS=""
HTTP_BODY=""

# ---------------------------------------------------------------- helpers begin
jget() {
  node -e '
    let data = "";
    process.stdin.on("data", (c) => (data += c)).on("end", () => {
      try {
        let v = JSON.parse(data);
        for (const k of process.argv[1].split(".")) { v = v == null ? v : v[k]; }
        process.stdout.write(v == null ? "" : String(v));
      } catch (e) { process.exit(1); }
    });
  ' "$1"
}

# Prints the sessionIds in a GET /api/sessions body, space separated.
list_ids() {
  node -e '
    let data = "";
    process.stdin.on("data", (c) => (data += c)).on("end", () => {
      try {
        process.stdout.write(JSON.parse(data).sessions.map((s) => s.sessionId).join(" "));
      } catch (e) { process.exit(1); }
    });
  '
}

# api METHOD PATH [JSON_BODY]  ->  sets HTTP_STATUS and HTTP_BODY
api() {
  local method="$1" path="$2" body="${3-}" out
  if [ -n "$body" ]; then
    out="$(curl -s -m 90 -X "$method" -H 'Content-Type: application/json' -d "$body" \
      -w $'\n%{http_code}' "${ORCH_URL}${path}")" || out=$'\n000'
  else
    out="$(curl -s -m 90 -X "$method" -w $'\n%{http_code}' "${ORCH_URL}${path}")" || out=$'\n000'
  fi
  HTTP_STATUS="${out##*$'\n'}"
  HTTP_BODY="${out%$'\n'*}"
}

# wait_until SECONDS cmd args...   (polls once per second)
wait_until() {
  local timeout="$1" i=0
  shift
  until "$@" > /dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
  done
}

rcli() { docker compose exec -T redis redis-cli "$@" | tr -d '\r'; }

container_running_for() { [ -n "$(docker ps -q --filter "label=live.session-id=$1")" ]; }
container_exists_for() { [ -n "$(docker ps -aq --filter "label=live.session-id=$1")" ]; }
container_gone_for() { ! container_exists_for "$1"; }
redis_has_session() { [ "$(rcli EXISTS "${REDIS_PREFIX}session:$1")" = "1" ]; }
redis_lacks_session() { [ "$(rcli EXISTS "${REDIS_PREFIX}session:$1")" = "0" ]; }
redis_index_has() { [ "$(rcli SISMEMBER "${REDIS_PREFIX}sessions" "$1")" = "1" ]; }
redis_index_lacks() { [ "$(rcli SISMEMBER "${REDIS_PREFIX}sessions" "$1")" = "0" ]; }
route_body_is() { [ "$(curl -s -m 3 -H "Host: $1" http://127.0.0.1:80/ || true)" = "$2" ]; }
route_body_is_not() { [ "$(curl -s -m 3 -H "Host: $1" http://127.0.0.1:80/ || true)" != "$2" ]; }
agent_healthy() { curl -sf -m 3 "$1/health" | grep -q '"status":"ok"'; }
# ------------------------------------------------------------------ helpers end

orchestrator_alive() { [ -n "$ORCH_PID" ] && kill -0 "$ORCH_PID" 2> /dev/null; }

# start_orchestrator LOGFILE IDLE_TIMEOUT_MS REAPER_INTERVAL_MS
start_orchestrator() {
  CURRENT_LOG="$1"
  (
    cd "$REPO_ROOT"
    exec env \
      ORCHESTRATOR_HOST=127.0.0.1 \
      ORCHESTRATOR_PORT="$ORCH_PORT" \
      REDIS_URL="redis://127.0.0.1:${REDIS_HOST_PORT}" \
      REDIS_KEY_PREFIX="$REDIS_PREFIX" \
      SESSION_HOST_SUFFIX=".localhost" \
      SANDBOX_IMAGE="$SANDBOX_IMAGE_TAG" \
      SESSION_IDLE_TIMEOUT_MS="$2" \
      IDLE_REAPER_INTERVAL_MS="$3" \
      RECONCILER_ORPHAN_POLICY="kill" \
      WEB_BASE_URL="http://localhost:5173" \
      node packages/orchestrator/dist/index.js
  ) >> "$1" 2>&1 &
  ORCH_PID=$!
  disown "$ORCH_PID" 2> /dev/null || true
}

wait_orchestrator_ready() {
  local i=0
  until curl -sf -m 2 "${ORCH_URL}/healthz" > /dev/null 2>&1; do
    if ! orchestrator_alive; then
      fail "orchestrator process exited during startup"
    fi
    i=$((i + 1))
    [ "$i" -ge 60 ] && fail "orchestrator never became healthy on ${ORCH_URL}"
    sleep 1
  done
}

# SIGKILL: simulates a crash. No shutdown hooks, no cleanup.
kill_orchestrator_hard() {
  if orchestrator_alive; then
    kill -9 "$ORCH_PID" 2> /dev/null || true
    wait_until 10 bash -c "! kill -0 $ORCH_PID 2>/dev/null" || true
  fi
  ORCH_PID=""
}

# SIGTERM: orderly shutdown.
stop_orchestrator_gracefully() {
  if orchestrator_alive; then
    kill -TERM "$ORCH_PID" 2> /dev/null || true
    if ! wait_until 15 bash -c "! kill -0 $ORCH_PID 2>/dev/null"; then
      kill -9 "$ORCH_PID" 2> /dev/null || true
    fi
  fi
  ORCH_PID=""
}

remove_session_containers() {
  local ids
  ids="$(docker ps -aq --filter "label=live.session-id=$1" 2> /dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rm -f $ids > /dev/null 2>&1 || true
  fi
}

cleanup() {
  kill_orchestrator_hard
  local id
  for id in $CREATED_SESSIONS; do
    remove_session_containers "$id"
  done
  remove_session_containers "p5-orphan"
  docker rm -f "$ROGUE_NAME" > /dev/null 2>&1 || true
  docker compose exec -T redis sh -c \
    "redis-cli --scan --pattern '${REDIS_PREFIX}*' | while read -r k; do redis-cli del \"\$k\" > /dev/null; done" \
    > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Creates a session through the API; sets NEW_SESSION_ID / NEW_CONTAINER_ID / NEW_AGENT_URL.
create_session_via_api() {
  api POST /api/sessions '{}'
  [ "$HTTP_STATUS" = "201" ] || fail "POST /api/sessions returned HTTP ${HTTP_STATUS}: ${HTTP_BODY}"
  NEW_SESSION_ID="$(printf '%s' "$HTTP_BODY" | jget sessionId)"
  NEW_CONTAINER_ID="$(printf '%s' "$HTTP_BODY" | jget containerId)"
  NEW_AGENT_URL="$(printf '%s' "$HTTP_BODY" | jget agentUrl)"
  [ -n "$NEW_SESSION_ID" ] || fail "POST /api/sessions response had no sessionId"
  CREATED_SESSIONS="$CREATED_SESSIONS $NEW_SESSION_ID"
}

# --------------------------------------------------------------------------
# 1. Regression: Phase 4 (which re-runs Phases 0-3).
# --------------------------------------------------------------------------
echo "== Phase 5 verify: Phase 4 regression suite (includes Phases 0-3) =="
bash phases/p4-dns-https/verify.sh
pass "Phase 4 regression suite (DNS/HTTPS, and everything under it)"
echo

echo "== Phase 5 verify: pnpm install =="
pnpm install --frozen-lockfile=false > "$LOG_DIR/install.log" 2>&1 \
  && pass "pnpm install" \
  || { cat "$LOG_DIR/install.log"; fail "pnpm install"; }
echo

echo "== Phase 5 verify: build all packages (incl. orchestrator control plane) =="
pnpm run build > "$LOG_DIR/build.log" 2>&1 \
  && pass "pnpm build" \
  || { cat "$LOG_DIR/build.log"; fail "pnpm build"; }
[ -f packages/orchestrator/dist/index.js ] || fail "packages/orchestrator/dist/index.js missing after build"
echo

echo "== Phase 5 verify: importing the orchestrator as a library has no side effects =="
# Phase 1/2 scripts import DockerManager from dist/index.js; that must not boot a server.
node -e 'import("./packages/orchestrator/dist/index.js").then((m) => { if (typeof m.DockerManager !== "function" || typeof m.startOrchestrator !== "function") process.exit(1); process.exit(0); })' \
  && pass "dist/index.js exports DockerManager + startOrchestrator and starts nothing on import" \
  || fail "importing dist/index.js failed or started the server"
echo

# --------------------------------------------------------------------------
# 2. Infrastructure: Redis + Traefik up, sandbox image present.
# --------------------------------------------------------------------------
echo "== Phase 5 verify: Redis, Traefik and the sandbox image =="
if [ -f ./scripts/ensure-proxy-network.sh ]; then
  PROXY_NETWORK_NAME="$NETWORK_NAME" bash ./scripts/ensure-proxy-network.sh > /dev/null 2>&1 \
    || fail "could not ensure docker network ${NETWORK_NAME}"
fi
docker compose up -d > "$LOG_DIR/compose-up.log" 2>&1 \
  && pass "docker compose up (redis + traefik + streaming + web)" \
  || { cat "$LOG_DIR/compose-up.log"; fail "docker compose up"; }

wait_until 40 bash -c "[ \"\$(docker compose exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')\" = PONG ]" \
  && pass "Redis answers PING (compose service 'redis')" \
  || fail "Redis never answered PING"
curl -sf -m 3 "http://127.0.0.1:8080/api/rawdata" > /dev/null 2>&1 \
  || wait_until 30 curl -sf -m 3 "http://127.0.0.1:8080/api/rawdata" \
  || fail "Traefik API not reachable on :8080"
pass "Traefik API reachable on :8080"
docker image inspect "$SANDBOX_IMAGE_TAG" > /dev/null 2>&1 \
  && pass "sandbox image ${SANDBOX_IMAGE_TAG} present" \
  || fail "sandbox image ${SANDBOX_IMAGE_TAG} missing (run scripts/seed-sandbox-image.sh)"
echo

note "The boot-time reconciler REMOVES any running container labelled live.managed=true that"
note "has no session record in the verify namespace. Stop real dev sessions before verifying."
echo

# --------------------------------------------------------------------------
# 3. Control plane boots; reconciler runs at boot; API is healthy.
# --------------------------------------------------------------------------
echo "== Phase 5 verify: orchestrator boots, reconciles, serves /healthz =="
LOG_MAIN="$LOG_DIR/orchestrator-1.log"
start_orchestrator "$LOG_MAIN" 600000 1000
wait_orchestrator_ready
api GET /healthz
[ "$HTTP_STATUS" = "200" ] && [ "$(printf '%s' "$HTTP_BODY" | jget redis)" = "true" ] \
  && pass "GET /healthz -> 200, redis: true" \
  || fail "GET /healthz unhealthy: ${HTTP_STATUS} ${HTTP_BODY}"
grep -q 'reconciler complete' "$LOG_MAIN" \
  && pass "reconciler ran at boot, before the API started serving" \
  || fail "no 'reconciler complete' line in the orchestrator log"
echo

# --------------------------------------------------------------------------
# 4. POST /api/sessions spawns a real sandbox and registers it.
# --------------------------------------------------------------------------
echo "== Phase 5 verify: POST /api/sessions =="
create_session_via_api
S1="$NEW_SESSION_ID"
S1_CID="$NEW_CONTAINER_ID"
S1_AGENT="$NEW_AGENT_URL"
HOST_URL="$(printf '%s' "$HTTP_BODY" | jget hostUrl)"
VIEWER_URL="$(printf '%s' "$HTTP_BODY" | jget viewerUrl)"

case "$HOST_URL" in *"/host?session=${S1}") pass "response has hostUrl: ${HOST_URL}" ;; *) fail "bad hostUrl: ${HOST_URL}" ;; esac
case "$VIEWER_URL" in *"/viewer?session=${S1}") pass "response has viewerUrl: ${VIEWER_URL}" ;; *) fail "bad viewerUrl: ${VIEWER_URL}" ;; esac
pass "response has sessionId: ${S1}"

container_running_for "$S1" \
  && pass "sandbox container is running (label live.session-id=${S1})" \
  || fail "no running container for ${S1}"
redis_has_session "$S1" && redis_index_has "$S1" \
  && pass "session record + index entry exist in Redis" \
  || fail "session ${S1} missing from Redis"
agent_healthy "$S1_AGENT" \
  && pass "sandbox-agent healthy at ${S1_AGENT}" \
  || fail "sandbox-agent not healthy at ${S1_AGENT}"

docker exec -d "$S1_CID" node -e "require('http').createServer((q,s)=>s.end('hello-from-${S1}')).listen(8080,'0.0.0.0')" \
  || fail "could not start a test web server inside the sandbox"
wait_until 40 route_body_is "${S1}.localhost" "hello-from-${S1}" \
  && pass "Traefik route auto-registered: http://${S1}.localhost/ -> sandbox:8080" \
  || fail "route for ${S1}.localhost never served the sandbox web server"

api GET "/api/sessions/${S1}"
[ "$HTTP_STATUS" = "200" ] && pass "GET /api/sessions/:id -> 200" || fail "GET /api/sessions/${S1} -> ${HTTP_STATUS}"
api GET /api/sessions
printf '%s' "$HTTP_BODY" | list_ids | grep -q "$S1" \
  && pass "GET /api/sessions lists the session" \
  || fail "session missing from GET /api/sessions: ${HTTP_BODY}"
api POST "/api/sessions/${S1}/heartbeat"
[ "$HTTP_STATUS" = "200" ] && pass "POST /api/sessions/:id/heartbeat -> 200" || fail "heartbeat -> ${HTTP_STATUS}"
echo

echo "== Phase 5 verify: API error handling =="
api POST /api/sessions '{not json'
[ "$HTTP_STATUS" = "400" ] && pass "invalid JSON body -> 400" || fail "invalid JSON -> ${HTTP_STATUS}"
api GET /api/sessions/doesnotexist
[ "$HTTP_STATUS" = "404" ] && pass "unknown session -> 404" || fail "unknown session -> ${HTTP_STATUS}"
api PUT /api/sessions
[ "$HTTP_STATUS" = "405" ] && pass "unsupported method -> 405" || fail "PUT /api/sessions -> ${HTTP_STATUS}"
echo

# --------------------------------------------------------------------------
# 5. Crash survival: SIGKILL the orchestrator mid-session, create every kind
#    of drift while it is down, restart it, and check the reconciler healed
#    all of it WITHOUT disturbing the healthy session.
# --------------------------------------------------------------------------
echo "== Phase 5 verify: crash survival + reconciler =="
create_session_via_api
S2="$NEW_SESSION_ID"
S2_CID="$NEW_CONTAINER_ID"
pass "created a second session (${S2}) to be killed behind the orchestrator's back"

kill_orchestrator_hard
pass "orchestrator killed with SIGKILL (simulated crash)"
container_running_for "$S1" \
  && pass "healthy session's container kept running while the orchestrator was down" \
  || fail "container for ${S1} died with the orchestrator"
redis_has_session "$S1" \
  && pass "healthy session's record survived in Redis" \
  || fail "record for ${S1} lost from Redis"

# Drift 1: a record whose container exists but is no longer running.
docker stop -t 1 "$S2_CID" > /dev/null 2>&1 || fail "could not stop ${S2}'s container"
# Drift 2: a record whose container does not exist at all.
NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
rcli HSET "${REDIS_PREFIX}session:${GHOST_ID}" schemaVersion 1 sessionId "$GHOST_ID" \
  containerId "$FAKE_CONTAINER_ID" image ghost-image hostAgentPort 59999 status running \
  createdAt "$NOW_MS" updatedAt "$NOW_MS" > /dev/null
rcli SADD "${REDIS_PREFIX}sessions" "$GHOST_ID" > /dev/null
redis_has_session "$GHOST_ID" || fail "could not seed the ghost record"
# Drift 3: a running managed container nobody has a record for.
docker run -d --name "$ROGUE_NAME" --network "$NETWORK_NAME" \
  --label live.managed=true --label live.session-id=p5-orphan \
  node:20-bookworm-slim sleep 600 > /dev/null 2>&1 \
  || fail "could not start the rogue orphan container"
pass "seeded drift: stopped-container record, ghost record, untracked orphan container"

LOG_RESTART="$LOG_DIR/orchestrator-2.log"
start_orchestrator "$LOG_RESTART" 600000 1000
wait_orchestrator_ready
pass "orchestrator restarted"

grep -q 'reconciler complete' "$LOG_RESTART" \
  && pass "reconciler.ts ran on restart" \
  || fail "no 'reconciler complete' line after restart"

# The healthy session is untouched AND still usable.
container_running_for "$S1" \
  && [ "$(docker ps -q --filter "label=live.session-id=${S1}" --no-trunc)" = "$S1_CID" ] \
  && pass "healthy session: same container, still running (not restarted)" \
  || fail "healthy session's container was replaced or stopped"
api GET "/api/sessions/${S1}"
[ "$HTTP_STATUS" = "200" ] && pass "healthy session: still served by the API after restart" || fail "GET ${S1} -> ${HTTP_STATUS}"
agent_healthy "$S1_AGENT" \
  && pass "healthy session: sandbox-agent still answers" \
  || fail "sandbox-agent for ${S1} stopped answering"
wait_until 20 route_body_is "${S1}.localhost" "hello-from-${S1}" \
  && pass "healthy session: Traefik route + in-sandbox web server still working" \
  || fail "route for ${S1}.localhost stopped working after the restart"
api POST "/api/sessions/${S1}/heartbeat"
[ "$HTTP_STATUS" = "200" ] && pass "healthy session: heartbeat accepted after restart" || fail "heartbeat after restart -> ${HTTP_STATUS}"

# Every drift was healed.
{ redis_lacks_session "$S2" && redis_index_lacks "$S2" && container_gone_for "$S2"; } \
  && pass "stopped-container session: container removed and record deleted" \
  || fail "session ${S2} (stopped container) was not cleaned up"
{ redis_lacks_session "$GHOST_ID" && redis_index_lacks "$GHOST_ID"; } \
  && pass "ghost record (no container): deleted from Redis and the index" \
  || fail "ghost record ${GHOST_ID} still in Redis"
[ -z "$(docker ps -aq --filter "name=^/${ROGUE_NAME}\$")" ] \
  && pass "untracked orphan container: removed" \
  || fail "orphan container ${ROGUE_NAME} still exists"
api GET /api/sessions
[ "$(printf '%s' "$HTTP_BODY" | list_ids)" = "$S1" ] \
  && pass "API now lists exactly the one healthy session" \
  || fail "unexpected sessions after reconcile: ${HTTP_BODY}"
echo

# --------------------------------------------------------------------------
# 6. DELETE /api/sessions/:id tears down container, proxy route, Redis keys.
# --------------------------------------------------------------------------
echo "== Phase 5 verify: DELETE /api/sessions/:id =="
api DELETE "/api/sessions/${S1}"
[ "$HTTP_STATUS" = "200" ] && pass "DELETE -> 200" || fail "DELETE ${S1} -> ${HTTP_STATUS}: ${HTTP_BODY}"
wait_until 20 container_gone_for "$S1" \
  && pass "container stopped and removed" \
  || fail "container for ${S1} still exists after DELETE"
{ redis_lacks_session "$S1" && redis_index_lacks "$S1"; } \
  && pass "Redis session key + index entry deleted" \
  || fail "Redis state for ${S1} still present after DELETE"
wait_until 30 route_body_is_not "${S1}.localhost" "hello-from-${S1}" \
  && pass "proxy route deregistered: http://${S1}.localhost/ no longer reaches the sandbox" \
  || fail "route for ${S1}.localhost still serving after DELETE"
if curl -s -m 3 http://127.0.0.1:8080/api/http/routers | grep -q "session-${S1}"; then
  fail "Traefik still lists a router for ${S1}"
fi
pass "Traefik no longer lists a router for the session"
api DELETE "/api/sessions/${S1}"
[ "$HTTP_STATUS" = "404" ] && pass "second DELETE -> 404" || fail "repeat DELETE -> ${HTTP_STATUS}"
echo

# --------------------------------------------------------------------------
# 7. Idle reaper: short timeout; one session heartbeats, one does not.
# --------------------------------------------------------------------------
echo "== Phase 5 verify: idle reaper (6s timeout, 1s sweep) =="
stop_orchestrator_gracefully
pass "orchestrator stopped gracefully (SIGTERM)"
LOG_IDLE="$LOG_DIR/orchestrator-3.log"
start_orchestrator "$LOG_IDLE" 6000 1000
wait_orchestrator_ready

create_session_via_api
S3="$NEW_SESSION_ID"   # never heartbeats
create_session_via_api
S4="$NEW_SESSION_ID"   # heartbeats every second
pass "created ${S3} (idle) and ${S4} (will heartbeat)"

i=0
while [ "$i" -lt 12 ]; do
  api POST "/api/sessions/${S4}/heartbeat"
  [ "$HTTP_STATUS" = "200" ] || fail "heartbeat for ${S4} -> ${HTTP_STATUS} (it was reaped while active)"
  i=$((i + 1))
  sleep 1
done

{ container_gone_for "$S3" && redis_lacks_session "$S3" && redis_index_lacks "$S3"; } \
  && pass "idle session reaped: container + Redis state removed after exceeding the timeout" \
  || fail "idle session ${S3} was not reaped"
{ container_running_for "$S4" && redis_has_session "$S4"; } \
  && pass "session with heartbeats survived past the idle timeout" \
  || fail "active session ${S4} was reaped despite heartbeats"

wait_until 40 container_gone_for "$S4" \
  && pass "after heartbeats stopped, the session was reaped too" \
  || fail "session ${S4} was never reaped after heartbeats stopped"
redis_lacks_session "$S4" && pass "its Redis state was removed" || fail "Redis state for ${S4} remains"
grep -q '"reason":"idle"' "$LOG_IDLE" \
  && pass "reaper logged the termination reason (idle)" \
  || fail "no idle termination in the orchestrator log"
echo

stop_orchestrator_gracefully

note "Heartbeats: sessions are measured from their last POST /api/sessions/:id/heartbeat."
note "Nothing in the web UI sends heartbeats yet (wired up with the streaming layer in Phase 6)."
note "Reconciler policy is 'kill' (RECONCILER_ORPHAN_POLICY=adopt re-registers orphans instead)."
echo "All Phase 5 checks passed."