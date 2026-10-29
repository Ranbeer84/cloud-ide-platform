#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
note() { echo "  NOTE: $1"; }
fail() {
  echo "  FAIL: $1"
  if [ -n "${ORCH_LOG:-}" ] && [ -f "$ORCH_LOG" ]; then
    echo "  --- last lines of the orchestrator log ($ORCH_LOG) ---"
    tail -n 25 "$ORCH_LOG" || true
  fi
  exit 1
}

for tool in docker curl node pnpm; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required to run Phase 7 verification but was not found on PATH"
done
docker compose version > /dev/null 2>&1 || fail "docker compose (v2 plugin) is required to run Phase 7 verification"

ORCH_PORT="${P7_ORCH_PORT:-4107}"
ORCH_URL="http://127.0.0.1:${ORCH_PORT}"
REDIS_HOST_PORT="${REDIS_HOST_PORT:-6379}"
REDIS_PREFIX="live-p7-verify:"
TRAEFIK_HTTP_PORT="${P7_TRAEFIK_PORT:-80}"
METADATA_IP="169.254.169.254"
LOG_DIR="$(mktemp -d /tmp/p7-verify.XXXXXX)"
ORCH_LOG="$LOG_DIR/orchestrator.log"
ORCH_PID=""
METADATA_IP_ADDED=0
CREATED_SESSION_IDS=()

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Runs a command as root: directly if we are root, through non-interactive sudo
# otherwise. Returns 1 (without prompting) if neither is possible.
can_root() { [ "$(id -u)" = "0" ] || sudo -n true 2> /dev/null; }
run_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

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

orch_alive() { [ -n "$ORCH_PID" ] && kill -0 "$ORCH_PID" 2> /dev/null; }
orch_healthy() { curl -sf -m 2 "${ORCH_URL}/healthz" > /dev/null 2>&1; }
rcli() { docker compose exec -T redis redis-cli "$@" | tr -d '\r'; }

# api METHOD PATH [TOKEN] [JSON_BODY]  -> prints the HTTP status; body goes to $LOG_DIR/body.json
api() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-s -o "$LOG_DIR/body.json" -w '%{http_code}' -X "$method")
  if [ -n "$token" ]; then
    args+=(-H "Authorization: Bearer ${token}")
  fi
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' -d "$body")
  fi
  curl "${args[@]}" "${ORCH_URL}${path}" || echo "000"
}

# jget DOTTED.PATH -> value from the last response body
jget() {
  node -e '
    const fs = require("fs");
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), body);
    if (value === undefined) { process.exit(2); }
    console.log(typeof value === "object" ? JSON.stringify(value) : value);
  ' "$LOG_DIR/body.json" "$1"
}

expect_status() { # expect_status WANT DESCRIPTION METHOD PATH [TOKEN] [BODY]
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

start_orchestrator() { # start_orchestrator LOGFILE
  (
    cd "$REPO_ROOT"
    exec env \
      ORCHESTRATOR_HOST="127.0.0.1" \
      ORCHESTRATOR_PORT="$ORCH_PORT" \
      REDIS_URL="redis://127.0.0.1:${REDIS_HOST_PORT}" \
      REDIS_KEY_PREFIX="$REDIS_PREFIX" \
      ORCHESTRATOR_AUTH_MODE="required" \
      ORCHESTRATOR_AUTH_SECRET="$P7_SECRET" \
      ORCHESTRATOR_AUTH_USERS="$P7_USERS" \
      MAX_SESSIONS_PER_USER="2" \
      SESSION_IDLE_TIMEOUT_MS="600000" \
      node packages/orchestrator/dist/index.js
  ) >> "$1" 2>&1 &
  ORCH_PID=$!
  local i
  for ((i = 0; i < 60; i++)); do
    if ! orch_alive; then
      fail "the orchestrator exited during startup"
    fi
    if orch_healthy; then
      return 0
    fi
    sleep 1
  done
  fail "the orchestrator never became healthy on ${ORCH_URL}"
}

stop_orchestrator_hard() { # SIGKILL: simulates a crash
  if orch_alive; then
    kill -9 "$ORCH_PID" 2> /dev/null || true
    wait "$ORCH_PID" 2> /dev/null || true
  fi
  ORCH_PID=""
}

container_exists() { docker inspect "$1" > /dev/null 2>&1; }
network_exists() { docker network ls --format '{{.Name}}' | grep -qx "$1"; }

cleanup() {
  stop_orchestrator_hard
  if [ "${#CREATED_SESSION_IDS[@]}" -gt 0 ]; then
    local id
    for id in "${CREATED_SESSION_IDS[@]}"; do
      docker ps -aq --filter "label=live.session-id=${id}" | xargs -r docker rm -f > /dev/null 2>&1 || true
      docker network rm "live-sbx-${id}" > /dev/null 2>&1 || true
    done
  fi
  docker compose exec -T redis sh -c \
    "redis-cli --scan --pattern '${REDIS_PREFIX}*' | while read -r k; do redis-cli del \"\$k\" > /dev/null; done" \
    > /dev/null 2>&1 || true
  if [ "$METADATA_IP_ADDED" = "1" ]; then
    run_root ip addr del "${METADATA_IP}/32" dev lo > /dev/null 2>&1 || true
  fi
  if [ "${P7_REMOVE_FIREWALL:-0}" = "1" ] && can_root; then
    run_root bash scripts/apply-sandbox-firewall.sh remove > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# 0. Preflight: gVisor must be registered with Docker. There is no fallback to
#    runc, so without it nothing below can mean anything.
# --------------------------------------------------------------------------
echo "== Phase 7 verify: preflight =="
RUNTIMES="$(docker info --format '{{json .Runtimes}}' 2> /dev/null || true)"
if ! echo "$RUNTIMES" | grep -q '"runsc"'; then
  echo "  Docker runtimes found: ${RUNTIMES:-none}"
  echo "  Install gVisor (https://gvisor.dev/docs/user_guide/install/), register it with Docker's"
  echo "  \"runtimes\" setting under the name runsc, restart Docker, and run this again."
  echo "  gVisor needs a Linux host: it cannot run under Docker Desktop on macOS or Windows."
  fail "the Docker runtime \"runsc\" (gVisor) is not registered"
fi
pass "Docker has the runsc (gVisor) runtime registered"
docker image inspect live/sandbox-base:latest > /dev/null 2>&1 \
  || fail "sandbox image live/sandbox-base:latest not found (build it as in Phase 1: scripts/seed-sandbox-image.sh)"
pass "sandbox image is present"
echo

# --------------------------------------------------------------------------
# 1. Regression: Phase 6 (which re-runs Phases 0-5).
#    Earlier phases drive the orchestrator API without credentials, so they run
#    with authentication switched off. That is only accepted on loopback, and
#    the variable is scoped to this one command: Phase 7's own tests below run
#    with authentication required.
# --------------------------------------------------------------------------
echo "== Phase 7 verify: Phase 6 regression suite (includes Phases 0-5) =="
ORCHESTRATOR_AUTH_MODE=disabled bash phases/p6-streaming-polish/verify.sh
pass "Phase 6 regression suite (and everything under it)"
echo

echo "== Phase 7 verify: pnpm install =="
pnpm install --frozen-lockfile=false > "$LOG_DIR/install.log" 2>&1 \
  && pass "pnpm install" \
  || { cat "$LOG_DIR/install.log"; fail "pnpm install"; }
echo

echo "== Phase 7 verify: build all packages =="
pnpm run build > "$LOG_DIR/build.log" 2>&1 \
  && pass "pnpm build" \
  || { cat "$LOG_DIR/build.log"; fail "pnpm build"; }
for artifact in \
  packages/orchestrator/dist/containers/gvisorManager.js \
  packages/orchestrator/dist/auth/authMiddleware.js; do
  [ -f "$artifact" ] || fail "$artifact missing after build"
done
pass "Phase 7 orchestrator modules were compiled (gvisorManager, authMiddleware)"
pnpm run lint:no-any > "$LOG_DIR/lint.log" 2>&1 \
  && pass "shared-types still has no 'any'" \
  || { cat "$LOG_DIR/lint.log"; fail "lint:no-any found an 'any' in shared-types"; }
echo

# --------------------------------------------------------------------------
# 2. Authentication and ownership (no Docker needed).
# --------------------------------------------------------------------------
echo "== Phase 7 verify: authentication, 401s, session ownership, schema v2 =="
node phases/p7-security/authCheck.mjs || fail "authentication checks failed (see the output above)"
pass "authentication checks"
echo

# --------------------------------------------------------------------------
# 3. Host firewall. Docker cannot stop a container reaching the host or metadata
#    endpoints; the firewall does. Optionally installed here.
# --------------------------------------------------------------------------
echo "== Phase 7 verify: host firewall for sandbox networks =="
if [ "${P7_APPLY_FIREWALL:-0}" = "1" ]; then
  can_root || fail "P7_APPLY_FIREWALL=1 needs root or passwordless sudo"
  run_root bash scripts/apply-sandbox-firewall.sh apply > "$LOG_DIR/firewall.log" 2>&1 \
    && pass "firewall rules installed by scripts/apply-sandbox-firewall.sh" \
    || { cat "$LOG_DIR/firewall.log"; fail "could not install the firewall rules"; }
elif can_root; then
  if run_root bash scripts/apply-sandbox-firewall.sh status > "$LOG_DIR/firewall.log" 2>&1; then
    pass "firewall rules are installed"
  else
    note "the firewall rules are not installed; the network checks below will fail unless something equivalent is in place"
    note "install them with P7_APPLY_FIREWALL=1, or run scripts/apply-sandbox-firewall.sh apply as root"
  fi
else
  note "no root access here, so the firewall state cannot be inspected; the network probes below decide"
fi

# A real address for the stand-in metadata service, so the block can be told apart from "no such host".
if can_root && ! ip addr show dev lo 2> /dev/null | grep -q "$METADATA_IP"; then
  if run_root ip addr add "${METADATA_IP}/32" dev lo > /dev/null 2>&1; then
    METADATA_IP_ADDED=1
    pass "stand-in metadata address ${METADATA_IP} assigned to loopback for the duration of this run"
  fi
fi
echo

# --------------------------------------------------------------------------
# 4. Sandbox hardening, pty under runsc, network isolation.
# --------------------------------------------------------------------------
echo "== Phase 7 verify: runsc runtime, pty regression under runsc, network isolation =="
P7_METADATA_IP="$METADATA_IP" node phases/p7-security/sandboxSecurityCheck.mjs \
  || fail "sandbox security checks failed (see the output above)"
pass "sandbox security checks"
echo

# --------------------------------------------------------------------------
# 5. The real stack with authentication required: orchestrator + Redis +
#    Traefik + gVisor sandboxes.
# --------------------------------------------------------------------------
echo "== Phase 7 verify: end to end, authentication required =="

echo "-- the orchestrator refuses to start with insecure authentication settings"
if (cd "$REPO_ROOT" && env -i PATH="$PATH" ORCHESTRATOR_PORT="$ORCH_PORT" node packages/orchestrator/dist/index.js) > "$LOG_DIR/noauth.log" 2>&1; then
  fail "the orchestrator started with no ORCHESTRATOR_AUTH_SECRET / ORCHESTRATOR_AUTH_USERS"
fi
grep -q "ORCHESTRATOR_AUTH_SECRET" "$LOG_DIR/noauth.log" \
  && pass "startup without a signing secret fails, and says why" \
  || { cat "$LOG_DIR/noauth.log"; fail "startup failure did not mention ORCHESTRATOR_AUTH_SECRET"; }

docker compose up -d redis traefik > "$LOG_DIR/compose-up.log" 2>&1 \
  && pass "docker compose up (redis, traefik)" \
  || { cat "$LOG_DIR/compose-up.log"; fail "docker compose up"; }
wait_until 40 bash -c "[ \"\$(docker compose exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')\" = PONG ]" \
  && pass "Redis answers PING" \
  || fail "Redis did not answer PING"

if orch_healthy; then
  fail "something is already answering on ${ORCH_URL}; set P7_ORCH_PORT to a free port"
fi

P7_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
ALICE_PASSWORD="alice-$(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"
BOB_PASSWORD="bob-$(node -e 'console.log(require("crypto").randomBytes(6).toString("hex"))')"
P7_USERS="$(ALICE_PASSWORD="$ALICE_PASSWORD" BOB_PASSWORD="$BOB_PASSWORD" node --input-type=module -e '
  const { hashPassword } = await import("./packages/orchestrator/dist/index.js");
  console.log(JSON.stringify([
    { id: "u_alice", username: "alice", passwordHash: await hashPassword(process.env.ALICE_PASSWORD) },
    { id: "u_bob", username: "bob", passwordHash: await hashPassword(process.env.BOB_PASSWORD) },
  ]));
')"
start_orchestrator "$ORCH_LOG"
pass "orchestrator started on ${ORCH_URL} with authentication required"

echo "-- unauthenticated calls"
expect_status 200 "GET /healthz needs no credentials" GET /healthz
expect_status 401 "POST /api/sessions without a token" POST /api/sessions
expect_status 401 "GET /api/sessions without a token" GET /api/sessions
expect_status 401 "GET /api/sessions/x without a token" GET /api/sessions/sdoesnotexist0000
expect_status 401 "POST heartbeat without a token" POST /api/sessions/sdoesnotexist0000/heartbeat
expect_status 401 "DELETE /api/sessions/x without a token" DELETE /api/sessions/sdoesnotexist0000
expect_status 401 "POST /api/sessions with a forged token" POST /api/sessions "v1.eyJzdWIiOiJ1X2FsaWNlIn0.AAAA"
expect_status 401 "login with a wrong password" POST /api/auth/login "" '{"username":"alice","password":"wrong"}'

echo "-- sign in"
expect_status 200 "alice signs in" POST /api/auth/login "" "{\"username\":\"alice\",\"password\":\"${ALICE_PASSWORD}\"}"
ALICE_TOKEN="$(jget token)"
expect_status 200 "bob signs in" POST /api/auth/login "" "{\"username\":\"bob\",\"password\":\"${BOB_PASSWORD}\"}"
BOB_TOKEN="$(jget token)"

echo "-- alice creates a real sandbox"
expect_status 201 "alice POST /api/sessions" POST /api/sessions "$ALICE_TOKEN"
SID="$(jget sessionId)"
CID="$(jget containerId)"
CREATED_SESSION_IDS+=("$SID")
RUNTIME_OF_SESSION="$(docker inspect -f '{{.HostConfig.Runtime}}' "$CID")"
[ "$RUNTIME_OF_SESSION" = "runsc" ] \
  && pass "the session's container runs under runsc" \
  || fail "the session's container runs under \"$RUNTIME_OF_SESSION\", not runsc"
network_exists "live-sbx-${SID}" \
  && pass "the session has its own network (live-sbx-${SID})" \
  || fail "per-session network live-sbx-${SID} is missing"
[ "$(rcli HGET "${REDIS_PREFIX}session:${SID}" ownerId)" = "u_alice" ] \
  && pass "Redis records alice as the owner" \
  || fail "the Redis record does not name u_alice as owner"
[ "$(rcli HGET "${REDIS_PREFIX}session:${SID}" schemaVersion)" = "2" ] \
  && pass "the Redis record uses schema version 2" \
  || fail "the Redis record is not schema version 2"

docker exec -d "$CID" node -e 'require("http").createServer((q,r)=>r.end("P7_PREVIEW_OK")).listen(8080,"0.0.0.0")' \
  || fail "could not start a test web server inside the sandbox"
wait_until 25 bash -c "curl -s -m 2 -H 'Host: ${SID}.localhost' http://127.0.0.1:${TRAEFIK_HTTP_PORT}/ | grep -q P7_PREVIEW_OK" \
  && pass "the preview route works through Traefik with per-session networks and the firewall in place" \
  || fail "Traefik did not route ${SID}.localhost to the sandbox (is Traefik on port ${TRAEFIK_HTTP_PORT}? set P7_TRAEFIK_PORT)"

echo "-- bob cannot reach alice's session"
expect_status 404 "bob GET alice's session" GET "/api/sessions/${SID}" "$BOB_TOKEN"
expect_status 404 "bob heartbeat on alice's session" POST "/api/sessions/${SID}/heartbeat" "$BOB_TOKEN"
expect_status 404 "bob DELETE alice's session" DELETE "/api/sessions/${SID}" "$BOB_TOKEN"
container_exists "$CID" \
  && pass "alice's container is still there after bob's DELETE attempt" \
  || fail "bob's DELETE removed alice's container"
expect_status 200 "bob lists his sessions" GET /api/sessions "$BOB_TOKEN"
[ "$(jget sessions)" = "[]" ] \
  && pass "bob's list is empty: alice's session is not shown to him" \
  || fail "bob's list contains sessions he does not own: $(jget sessions)"
expect_status 200 "alice lists her sessions" GET /api/sessions "$ALICE_TOKEN"
[[ "$(jget sessions)" == *"$SID"* ]] \
  && pass "alice's list contains her session" \
  || fail "alice's list is missing her session"

echo "-- ownership survives an orchestrator crash"
stop_orchestrator_hard
start_orchestrator "$ORCH_LOG"
expect_status 200 "alice GET her session after the restart" GET "/api/sessions/${SID}" "$ALICE_TOKEN"
expect_status 404 "bob GET alice's session after the restart" GET "/api/sessions/${SID}" "$BOB_TOKEN"
expect_status 200 "alice heartbeat" POST "/api/sessions/${SID}/heartbeat" "$ALICE_TOKEN"

echo "-- alice's session cap"
expect_status 201 "alice's second session" POST /api/sessions "$ALICE_TOKEN"
SID2="$(jget sessionId)"
CREATED_SESSION_IDS+=("$SID2")
expect_status 429 "alice's third session is refused (limit 2)" POST /api/sessions "$ALICE_TOKEN"
expect_status 200 "alice ends the second session" DELETE "/api/sessions/${SID2}" "$ALICE_TOKEN"

echo "-- alice ends her session; everything it created is cleaned up"
expect_status 200 "alice DELETE her session" DELETE "/api/sessions/${SID}" "$ALICE_TOKEN"
wait_until 10 bash -c "! docker inspect '$CID' > /dev/null 2>&1" \
  && pass "the container is gone" \
  || fail "the container still exists after DELETE"
wait_until 10 bash -c "! docker network ls --format '{{.Name}}' | grep -qx 'live-sbx-${SID}'" \
  && pass "the session network is gone" \
  || fail "network live-sbx-${SID} still exists after DELETE"
[ "$(rcli EXISTS "${REDIS_PREFIX}session:${SID}")" = "0" ] \
  && pass "the Redis record is gone" \
  || fail "the Redis record still exists after DELETE"
expect_status 404 "alice GET the deleted session" GET "/api/sessions/${SID}" "$ALICE_TOKEN"
echo

orch_alive || fail "the orchestrator died during the end-to-end run"
pass "the orchestrator survived the whole run"
echo

note "The sandbox agent has no authentication of its own yet. It is published on 127.0.0.1 only and blocked from other sandboxes,"
note "but anything running on this host can reach it. Do not expose the agent port beyond the host until it is proxied behind this auth."
note "Firewall rules are not persistent across reboots: apply them at boot (scripts/apply-sandbox-firewall.sh apply)."
note "HostPage and ViewerPage are not yet behind <RequireAuth>, so the browser UI is not exercised here."
echo "All Phase 7 checks passed."