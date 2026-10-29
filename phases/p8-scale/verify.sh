#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
note() { echo "  NOTE: $1"; }
fail() {
  echo "  FAIL: $1"
  if [ -n "${COMPOSE_LOGS_ON_FAIL:-}" ]; then
    echo "  --- last log lines of the Phase 8 stack ---"
    $COMPOSE logs --tail=15 orchestrator-1 orchestrator-2 streaming-1 streaming-2 2> /dev/null || true
  fi
  exit 1
}

for tool in docker curl node pnpm; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required to run Phase 8 verification but was not found on PATH"
done
docker compose version > /dev/null 2>&1 || fail "docker compose (v2 plugin) is required"
COMPOSE_VERSION="$(docker compose version --short | sed 's/^v//')"
[ "$(printf '%s\n' "2.23.1" "$COMPOSE_VERSION" | sort -V | head -n1)" = "2.23.1" ] \
  || fail "Docker Compose >= 2.23.1 is required for docker-compose.prod.yml (found ${COMPOSE_VERSION})"

# --------------------------------------------------------------------------
# Settings. A separate compose project, ports, container name and key prefix
# keep this run away from a real production stack and from the dev stack.
# --------------------------------------------------------------------------
P8_PROJECT="${P8_PROJECT:-live-p8-verify}"
COMPOSE="docker compose -p ${P8_PROJECT} -f docker-compose.prod.yml"
export PROD_HTTP_PORT="${P8_HTTP_PORT:-8088}"
export PROD_HTTPS_PORT="${P8_HTTPS_PORT:-8443}"
export ORCHESTRATOR_LB_PORT="${P8_LB_PORT:-4150}"
export ORCHESTRATOR_1_PORT="${P8_ORCH1_PORT:-4151}"
export ORCHESTRATOR_2_PORT="${P8_ORCH2_PORT:-4152}"
export STREAMING_1_PORT="${P8_STREAM1_PORT:-4251}"
export STREAMING_2_PORT="${P8_STREAM2_PORT:-4252}"
export PROD_REDIS_PORT="${P8_REDIS_PORT:-6381}"
export PROD_POSTGRES_PORT="${P8_POSTGRES_PORT:-5434}"
export PROXY_CONTAINER_NAME="live-p8-traefik"
export REDIS_KEY_PREFIX="live-p8-verify:"
export MAX_SESSIONS_PER_USER="10"
export SESSION_IDLE_TIMEOUT_MS="600000"
export STREAMING_HOST="streaming.localhost"

LB="http://127.0.0.1:${ORCHESTRATOR_LB_PORT}"
O1="http://127.0.0.1:${ORCHESTRATOR_1_PORT}"
O2="http://127.0.0.1:${ORCHESTRATOR_2_PORT}"
S1="http://127.0.0.1:${STREAMING_1_PORT}"
S2="http://127.0.0.1:${STREAMING_2_PORT}"
TRAEFIK_URL="http://127.0.0.1:${PROD_HTTP_PORT}"

LOG_DIR="$(mktemp -d /tmp/p8-verify.XXXXXX)"
CREATED_SESSION_IDS=()
LOAD_PID=""
COMPOSE_LOGS_ON_FAIL=""

wait_until() { # wait_until SECONDS CMD...
  local seconds="$1"
  shift
  local i
  for ((i = 0; i < seconds; i++)); do
    if "$@" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

url_ok() { curl -sf -m 2 "$1" > /dev/null 2>&1; }
pg() { $COMPOSE exec -T postgres psql -U live -d live -tAc "$1" | tr -d '\r'; }

# api BASE METHOD PATH [TOKEN] [JSON_BODY] -> HTTP status; body in $LOG_DIR/body.json
api() {
  local base="$1" method="$2" path="$3" token="${4:-}" body="${5:-}"
  local args=(-s -o "$LOG_DIR/body.json" -w '%{http_code}' -m 90 -X "$method")
  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer ${token}")
  fi
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi
  curl "${args[@]}" "${base}${path}" || echo "000"
}

jget() {
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), body);
    if (value === undefined) { process.exit(2); }
    console.log(typeof value === "object" ? JSON.stringify(value) : value);
  ' "$LOG_DIR/body.json" "$1"
}

expect_status() { # expect_status WANT DESCRIPTION BASE METHOD PATH [TOKEN] [BODY]
  local want="$1" description="$2"
  shift 2
  local got
  got="$(api "$@")"
  if [ "$got" = "$want" ]; then
    pass "$description -> $want"
  else
    echo "  response body: $(cat "$LOG_DIR/body.json" 2> /dev/null || true)"
    fail "$description: expected HTTP $want, got $got"
  fi
}

stop_load() {
  rm -f "$LOG_DIR/load.run"
  if [ -n "$LOAD_PID" ]; then
    wait "$LOAD_PID" 2> /dev/null || true
    LOAD_PID=""
  fi
}

cleanup() {
  stop_load
  local id
  for id in "${CREATED_SESSION_IDS[@]:-}"; do
    [ -n "$id" ] || continue
    docker ps -aq --filter "label=live.session-id=${id}" | xargs -r docker rm -f > /dev/null 2>&1 || true
    docker network rm "live-sbx-${id}" > /dev/null 2>&1 || true
  done
  if [ "${P8_KEEP_STACK:-0}" != "1" ]; then
    $COMPOSE down -v --remove-orphans > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# 0. Preflight (same requirement as Phase 7: there is no runc fallback).
# --------------------------------------------------------------------------
echo "== Phase 8 verify: preflight =="
docker info --format '{{json .Runtimes}}' 2> /dev/null | grep -q '"runsc"' \
  || fail "the Docker runtime \"runsc\" (gVisor) is not registered (see Phase 7)"
pass "Docker has the runsc runtime registered"
docker image inspect live/sandbox-base:latest > /dev/null 2>&1 \
  || fail "sandbox image live/sandbox-base:latest not found (scripts/seed-sandbox-image.sh)"
pass "sandbox image is present"
echo

# --------------------------------------------------------------------------
# 1. Regression: Phase 7 (which re-runs Phases 0-6 and tears down what it starts).
# --------------------------------------------------------------------------
echo "== Phase 8 verify: Phase 7 regression suite (includes Phases 0-6) =="
bash phases/p7-security/verify.sh
pass "Phase 7 regression suite (and everything under it)"
echo

echo "== Phase 8 verify: pnpm install, build, lint =="
pnpm install --frozen-lockfile=false > "$LOG_DIR/install.log" 2>&1 \
  && pass "pnpm install" \
  || { cat "$LOG_DIR/install.log"; fail "pnpm install"; }
pnpm run build > "$LOG_DIR/build.log" 2>&1 \
  && pass "pnpm build" \
  || { cat "$LOG_DIR/build.log"; fail "pnpm build"; }
for artifact in \
  packages/streaming/dist/redisAdapter.js \
  packages/orchestrator/dist/db/postgres.js; do
  [ -f "$artifact" ] || fail "$artifact missing after build"
done
pass "Phase 8 modules were compiled (redisAdapter, postgres)"
pnpm run lint:no-any > "$LOG_DIR/lint.log" 2>&1 \
  && pass "shared-types still has no 'any'" \
  || { cat "$LOG_DIR/lint.log"; fail "lint:no-any found an 'any' in shared-types"; }
echo

# --------------------------------------------------------------------------
# 2. Bring up the multi-replica stack.
# --------------------------------------------------------------------------
echo "== Phase 8 verify: start the multi-replica stack =="
rand() { node -e 'console.log(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }
export POSTGRES_PASSWORD="pg$(rand 12)"
export REDIS_PASSWORD="rd$(rand 12)"
export ORCHESTRATOR_AUTH_SECRET="$(rand 32)"
ALICE_PASSWORD="alice-$(rand 6)"
BOB_PASSWORD="bob-$(rand 6)"
ORCHESTRATOR_AUTH_USERS="$(ALICE_PASSWORD="$ALICE_PASSWORD" BOB_PASSWORD="$BOB_PASSWORD" node --input-type=module -e '
  const { hashPassword } = await import("./packages/orchestrator/dist/index.js");
  console.log(JSON.stringify([
    { id: "u_alice", username: "alice", passwordHash: await hashPassword(process.env.ALICE_PASSWORD) },
    { id: "u_bob", username: "bob", passwordHash: await hashPassword(process.env.BOB_PASSWORD) },
  ]));
')"
export ORCHESTRATOR_AUTH_USERS

COMPOSE_LOGS_ON_FAIL=1
$COMPOSE config -q > "$LOG_DIR/config.log" 2>&1 \
  && pass "docker-compose.prod.yml is valid" \
  || { cat "$LOG_DIR/config.log"; fail "docker-compose.prod.yml is not valid"; }
for expected in orchestrator-1 orchestrator-2 streaming-1 streaming-2 redis postgres traefik orchestrator-lb; do
  $COMPOSE config --services | grep -qx "$expected" || fail "service $expected is missing from docker-compose.prod.yml"
done
pass "the stack defines 2 orchestrator replicas, 2 streaming replicas, Traefik, a load balancer, Redis and Postgres"

for port in "$PROD_HTTP_PORT" "$ORCHESTRATOR_LB_PORT" "$ORCHESTRATOR_1_PORT" "$ORCHESTRATOR_2_PORT" "$STREAMING_1_PORT" "$STREAMING_2_PORT"; do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:${port}/"; then
    fail "something already answers on port ${port}; set the P8_* port variables to free ports"
  fi
done

bash scripts/ensure-proxy-network.sh > /dev/null 2>&1 || fail "scripts/ensure-proxy-network.sh failed"
$COMPOSE up -d > "$LOG_DIR/compose-up.log" 2>&1 \
  && pass "docker compose up -d" \
  || { cat "$LOG_DIR/compose-up.log"; fail "docker compose up -d"; }

wait_until 240 url_ok "${O1}/healthz" || fail "orchestrator-1 never became healthy"
wait_until 240 url_ok "${O2}/healthz" || fail "orchestrator-2 never became healthy"
wait_until 60 url_ok "${LB}/healthz" || fail "the orchestrator load balancer never answered"
wait_until 120 url_ok "${S1}/health" || fail "streaming-1 never became healthy"
wait_until 120 url_ok "${S2}/health" || fail "streaming-2 never became healthy"
pass "both orchestrators, both streaming replicas and the load balancer answer"
echo

# --------------------------------------------------------------------------
# 3. Orchestrator replicas share state through Redis (real sandboxes).
# --------------------------------------------------------------------------
echo "== Phase 8 verify: orchestrator replicas share session state =="
expect_status 200 "alice signs in on replica 1" "$O1" POST /api/auth/login "" "{\"username\":\"alice\",\"password\":\"${ALICE_PASSWORD}\"}"
ALICE_TOKEN="$(jget token)"
expect_status 200 "bob signs in on replica 2" "$O2" POST /api/auth/login "" "{\"username\":\"bob\",\"password\":\"${BOB_PASSWORD}\"}"
BOB_TOKEN="$(jget token)"
expect_status 200 "a token issued by replica 1 is accepted by replica 2" "$O2" GET /api/sessions "$ALICE_TOKEN"

expect_status 201 "alice creates a session through replica 1" "$O1" POST /api/sessions "$ALICE_TOKEN"
SID="$(jget sessionId)"
CID="$(jget containerId)"
CREATED_SESSION_IDS+=("$SID")
[ "$(docker inspect -f '{{.HostConfig.Runtime}}' "$CID")" = "runsc" ] \
  && pass "the sandbox started by a replica container runs under runsc" \
  || fail "the sandbox does not run under runsc"

expect_status 200 "replica 2 reads the session replica 1 created" "$O2" GET "/api/sessions/${SID}" "$ALICE_TOKEN"
expect_status 404 "bob cannot read it through replica 2" "$O2" GET "/api/sessions/${SID}" "$BOB_TOKEN"
expect_status 200 "a heartbeat sent to replica 2 is accepted" "$O2" POST "/api/sessions/${SID}/heartbeat" "$ALICE_TOKEN"
expect_status 200 "replica 1 lists the session" "$O1" GET /api/sessions "$ALICE_TOKEN"
[[ "$(jget sessions)" == *"$SID"* ]] && pass "the list from replica 1 contains it" || fail "replica 1 does not list the session"

docker exec -d "$CID" node -e 'require("http").createServer((q,r)=>r.end("P8_PREVIEW_OK")).listen(8080,"0.0.0.0")' \
  || fail "could not start a test web server in the sandbox"
wait_until 30 bash -c "curl -s -m 2 -H 'Host: ${SID}.localhost' ${TRAEFIK_URL}/ | grep -q P8_PREVIEW_OK" \
  && pass "the preview route works through the Phase 8 Traefik" \
  || fail "the Phase 8 Traefik did not route ${SID}.localhost"

echo "-- Postgres captured the lifecycle"
wait_until 15 bash -c "[ \"\$(docker compose -p ${P8_PROJECT} -f docker-compose.prod.yml exec -T postgres psql -U live -d live -tAc \"SELECT owner_id FROM session_history WHERE session_id='${SID}' AND ended_at IS NULL\" | tr -d '\r')\" = u_alice ]" \
  && pass "session_history has an open row owned by u_alice" \
  || fail "no open session_history row for ${SID}"
[ "$(pg "SELECT count(*) FROM accounts WHERE id IN ('u_alice','u_bob')")" = "2" ] \
  && pass "both configured accounts were synced into Postgres" \
  || fail "accounts were not synced"

expect_status 200 "alice ends it through replica 2" "$O2" DELETE "/api/sessions/${SID}" "$ALICE_TOKEN"
expect_status 404 "replica 1 no longer finds it" "$O1" GET "/api/sessions/${SID}" "$ALICE_TOKEN"
wait_until 15 bash -c "docker inspect '$CID' > /dev/null 2>&1 && exit 1 || exit 0" \
  && pass "the container is gone" || fail "the container survived DELETE"
wait_until 15 bash -c "[ \"\$(docker compose -p ${P8_PROJECT} -f docker-compose.prod.yml exec -T postgres psql -U live -d live -tAc \"SELECT (ended_at IS NOT NULL AND end_replica IS NOT NULL AND ended_at >= started_at)::text FROM session_history WHERE session_id='${SID}'\" | tr -d '\r')\" = true ]" \
  && pass "the history row now has an end time and the replica that ended it" \
  || fail "session_history was not closed for ${SID}"
[ "$(pg "SELECT count(*) FROM audit_log WHERE session_id='${SID}' AND event IN ('session.started','session.ended')")" = "2" ] \
  && pass "the audit log holds the start and the end" \
  || fail "audit_log is missing start/end events for ${SID}"
echo

# --------------------------------------------------------------------------
# 4. Streaming replicas: Socket.IO over the Redis adapter, behind Traefik.
# --------------------------------------------------------------------------
echo "== Phase 8 verify: Socket.IO routing across streaming replicas =="
STREAMING_A_URL="$S1" STREAMING_B_URL="$S2" STREAMING_LB_URL="$TRAEFIK_URL" STREAMING_LB_HOST="$STREAMING_HOST" \
  node phases/p8-scale/clusterCheck.mjs sockets || fail "cross-replica socket checks failed (see above)"
pass "cross-replica socket checks"
echo

# --------------------------------------------------------------------------
# 5. Postgres: schema, concurrency, durability across a restart.
# --------------------------------------------------------------------------
echo "== Phase 8 verify: Postgres =="
PG_URL="postgres://live:${POSTGRES_PASSWORD}@127.0.0.1:${PROD_POSTGRES_PORT}/live"
DATABASE_URL="$PG_URL" REDIS_URL="redis://:${REDIS_PASSWORD}@127.0.0.1:${PROD_REDIS_PORT}" REDIS_KEY_PREFIX="live-p8-check:" \
  node phases/p8-scale/clusterCheck.mjs store || fail "orchestrator store checks failed (see above)"
pass "two orchestrator stores over one Redis and Postgres"
DATABASE_URL="$PG_URL" \
RESTART_DB_CMD="$COMPOSE restart postgres > /dev/null && until $COMPOSE exec -T postgres pg_isready -U live -d live > /dev/null 2>&1; do sleep 1; done" \
  node phases/p8-scale/clusterCheck.mjs postgres || fail "Postgres checks failed (see above)"
pass "Postgres checks (including a restart of the database)"

echo "-- the orchestrators recover after the Postgres restart"
expect_status 201 "alice creates a session after the restart" "$LB" POST /api/sessions "$ALICE_TOKEN"
SID="$(jget sessionId)"
CREATED_SESSION_IDS+=("$SID")
wait_until 20 bash -c "[ \"\$(docker compose -p ${P8_PROJECT} -f docker-compose.prod.yml exec -T postgres psql -U live -d live -tAc \"SELECT count(*) FROM session_history WHERE session_id='${SID}'\" | tr -d '\r')\" = 1 ]" \
  && pass "history is being written again" \
  || fail "no history row for ${SID} after the Postgres restart"
expect_status 200 "alice ends it" "$LB" DELETE "/api/sessions/${SID}" "$ALICE_TOKEN"
echo

# --------------------------------------------------------------------------
# 6. Rolling restart of the orchestrators under load.
# --------------------------------------------------------------------------
echo "== Phase 8 verify: rolling restart of the orchestrator replicas =="
expect_status 201 "alice creates a long-lived session" "$LB" POST /api/sessions "$ALICE_TOKEN"
KEEP_SID="$(jget sessionId)"
KEEP_CID="$(jget containerId)"
CREATED_SESSION_IDS+=("$KEEP_SID")

: > "$LOG_DIR/load.fail"
: > "$LOG_DIR/load.ok"
touch "$LOG_DIR/load.run"
(
  while [ -f "$LOG_DIR/load.run" ]; do
    code="$(curl -s -o "$LOG_DIR/load.body" -w '%{http_code}' -m 90 -X POST -H "Authorization: Bearer ${ALICE_TOKEN}" "${LB}/api/sessions" || echo 000)"
    if [ "$code" = "201" ]; then
      id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sessionId)' "$LOG_DIR/load.body")"
      echo "$id" >> "$LOG_DIR/load.ids"
      code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X DELETE -H "Authorization: Bearer ${ALICE_TOKEN}" "${LB}/api/sessions/${id}" || echo 000)"
      if [ "$code" = "200" ]; then echo ok >> "$LOG_DIR/load.ok"; else echo "delete ${id} -> ${code}" >> "$LOG_DIR/load.fail"; fi
    else
      echo "create -> ${code}: $(cat "$LOG_DIR/load.body" 2> /dev/null)" >> "$LOG_DIR/load.fail"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Authorization: Bearer ${ALICE_TOKEN}" "${LB}/api/sessions" || echo 000)"
    [ "$code" = "200" ] || echo "list -> ${code}" >> "$LOG_DIR/load.fail"
  done
) &
LOAD_PID=$!
sleep 4

for replica in 1 2; do
  port_var="ORCHESTRATOR_${replica}_PORT"
  $COMPOSE restart "orchestrator-${replica}" > /dev/null 2>&1 || fail "could not restart orchestrator-${replica}"
  wait_until 120 url_ok "http://127.0.0.1:${!port_var}/healthz" || fail "orchestrator-${replica} did not come back"
  pass "orchestrator-${replica} was restarted and is healthy again"
  sleep 3
done
stop_load

OK_COUNT="$(wc -l < "$LOG_DIR/load.ok" | tr -d ' ')"
[ "$OK_COUNT" -ge 3 ] || fail "the load generator completed only ${OK_COUNT} create/delete cycles; the restart test proved nothing"
if [ -s "$LOG_DIR/load.fail" ]; then
  cat "$LOG_DIR/load.fail"
  fail "requests failed during the rolling restart"
fi
pass "${OK_COUNT} create/delete cycles and every list request succeeded through both restarts, with no failures"

docker inspect -f '{{.State.Running}}' "$KEEP_CID" 2> /dev/null | grep -q true \
  && pass "the long-lived sandbox kept running through both restarts (reconciliation did not kill it)" \
  || fail "the long-lived sandbox was killed during the restarts"
expect_status 200 "the long-lived session is still readable on replica 1" "$O1" GET "/api/sessions/${KEEP_SID}" "$ALICE_TOKEN"
expect_status 200 "and on replica 2" "$O2" GET "/api/sessions/${KEEP_SID}" "$ALICE_TOKEN"
expect_status 200 "and a heartbeat still works" "$LB" POST "/api/sessions/${KEEP_SID}/heartbeat" "$ALICE_TOKEN"

LEFTOVER=0
if [ -f "$LOG_DIR/load.ids" ]; then
  while read -r id; do
    if docker ps -aq --filter "label=live.session-id=${id}" | grep -q .; then LEFTOVER=$((LEFTOVER + 1)); fi
  done < "$LOG_DIR/load.ids"
fi
[ "$LEFTOVER" = "0" ] \
  && pass "no container of a load-test session was left behind" \
  || fail "${LEFTOVER} load-test containers were left behind"
expect_status 200 "the long-lived session is ended" "$LB" DELETE "/api/sessions/${KEEP_SID}" "$ALICE_TOKEN"
echo

# --------------------------------------------------------------------------
# 7. Rolling restart of a streaming replica.
# --------------------------------------------------------------------------
echo "== Phase 8 verify: rolling restart of a streaming replica =="
STREAMING_A_URL="$S1" STREAMING_B_URL="$S2" STREAMING_LB_URL="$TRAEFIK_URL" STREAMING_LB_HOST="$STREAMING_HOST" \
RESTART_CMD="$COMPOSE restart streaming-1 > /dev/null && until curl -sf -m 2 ${S1}/health > /dev/null 2>&1; do sleep 1; done" \
  node phases/p8-scale/clusterCheck.mjs restart || fail "streaming rolling restart checks failed (see above)"
pass "streaming rolling restart"
wait_until 60 bash -c "curl -sf -m 2 ${S1}/health | grep -q '\"nodes\":2'" \
  && pass "the restarted replica rejoined the cluster (2 nodes)" \
  || fail "the cluster does not show 2 nodes after the restart"
echo

COMPOSE_LOGS_ON_FAIL=""
note "Connections on the replica being restarted ARE closed (that is what restarting means). The guarantees checked: its clients reconnect"
note "on their own, no new connection is refused, and nothing on the other replica is dropped. A room lives on its host's replica, so"
note "rooms hosted on the restarted replica end; viewers on the other replica receive session:ended."
note "Redis and Postgres are single instances here: this phase scales the stateless tiers, not the data tier."
note "The orchestrator load balancer binds ${ORCHESTRATOR_LB_BIND:-127.0.0.1} by default; put your public proxy in front of it."
echo "All Phase 8 checks passed."