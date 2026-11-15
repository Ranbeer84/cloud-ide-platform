#!/usr/bin/env bash
# Phase 9 gate: operability (structured logs, /metrics, alert rules, CI wiring).
#
#   bash phases/p9-operability/verify.sh
#
# Runs, in order:
#   1. regression: Phase 8 (which re-runs Phases 7 and below, so P0-P8 in full)
#   2. install, build, type-check and lint
#   3. structured logger behaviour (in-process)
#   4. /metrics through the real HTTP handler (in-process) + exposition lint
#   5. Prometheus config, alert rules and the alert unit tests (promtool)
#   6. GitHub Actions workflow wiring
#   7. /metrics on the real two-replica stack, with a real sandbox
#
# Optional switches, for splitting this gate across CI jobs (a run that uses
# them says so in its last line and is NOT a full Phase 9 pass):
#   P9_SKIP_REGRESSION=1   skip step 1
#   P9_SKIP_STACK=1        skip step 7 (the only step that needs Docker + gVisor besides step 1)
#   P9_PNPM_INSTALL_FLAGS  extra flags for `pnpm install` (default: none)
#   P9_KEEP_STACK=1        leave the step-7 compose project running afterwards
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

pass() { echo "  PASS: $1"; }
note() { echo "  NOTE: $1"; }
fail() {
  echo "  FAIL: $1"
  if [ -n "${COMPOSE_LOGS_ON_FAIL:-}" ]; then
    echo "  --- last log lines of the Phase 9 stack ---"
    $COMPOSE logs --tail=20 orchestrator-1 orchestrator-2 2> /dev/null || true
  fi
  exit 1
}

SKIP_REGRESSION="${P9_SKIP_REGRESSION:-0}"
SKIP_STACK="${P9_SKIP_STACK:-0}"
SKIPPED=()

for tool in node pnpm curl; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required to run Phase 9 verification but was not found on PATH"
done
NEEDS_DOCKER=0
if [ "$SKIP_REGRESSION" != "1" ] || [ "$SKIP_STACK" != "1" ]; then
  NEEDS_DOCKER=1
fi
if [ "$NEEDS_DOCKER" = "1" ]; then
  command -v docker > /dev/null 2>&1 || fail "docker is required (or set P9_SKIP_REGRESSION=1 and P9_SKIP_STACK=1 to skip the Docker-backed steps)"
  docker compose version > /dev/null 2>&1 || fail "docker compose (v2 plugin) is required"
fi
if ! command -v promtool > /dev/null 2>&1; then
  command -v docker > /dev/null 2>&1 || fail "promtool is not on PATH and docker is not available to run it"
fi

# --------------------------------------------------------------------------
# Settings. A separate compose project, ports, container name and key prefix
# keep step 7 away from Phase 8's stack, the dev stack and any real stack.
# --------------------------------------------------------------------------
P9_PROJECT="${P9_PROJECT:-live-p9-verify}"
COMPOSE="docker compose -p ${P9_PROJECT} -f docker-compose.prod.yml"
export PROD_HTTP_PORT="${P9_HTTP_PORT:-8089}"
export PROD_HTTPS_PORT="${P9_HTTPS_PORT:-8444}"
export ORCHESTRATOR_LB_PORT="${P9_LB_PORT:-4160}"
export ORCHESTRATOR_1_PORT="${P9_ORCH1_PORT:-4161}"
export ORCHESTRATOR_2_PORT="${P9_ORCH2_PORT:-4162}"
export STREAMING_1_PORT="${P9_STREAM1_PORT:-4261}"
export STREAMING_2_PORT="${P9_STREAM2_PORT:-4262}"
export PROD_REDIS_PORT="${P9_REDIS_PORT:-6382}"
export PROD_POSTGRES_PORT="${P9_POSTGRES_PORT:-5435}"
export PROXY_CONTAINER_NAME="live-p9-traefik"
export REDIS_KEY_PREFIX="live-p9-verify:"
export MAX_SESSIONS_PER_USER="10"
export SESSION_IDLE_TIMEOUT_MS="600000"

LB="http://127.0.0.1:${ORCHESTRATOR_LB_PORT}"
O1="http://127.0.0.1:${ORCHESTRATOR_1_PORT}"
O2="http://127.0.0.1:${ORCHESTRATOR_2_PORT}"
PROMTOOL_IMAGE="${PROMTOOL_IMAGE:-prom/prometheus:v2.54.1}"

LOG_DIR="$(mktemp -d /tmp/p9-verify.XXXXXX)"
CREATED_SESSION_IDS=()
COMPOSE_LOGS_ON_FAIL=""
STACK_STARTED=0

cleanup() {
  local id
  for id in "${CREATED_SESSION_IDS[@]:-}"; do
    [ -n "$id" ] || continue
    docker ps -aq --filter "label=live.session-id=${id}" | xargs -r docker rm -f > /dev/null 2>&1 || true
    docker network rm "live-sbx-${id}" > /dev/null 2>&1 || true
  done
  if [ "$STACK_STARTED" = "1" ] && [ "${P9_KEEP_STACK:-0}" != "1" ]; then
    $COMPOSE down -v --remove-orphans > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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

# promtool from PATH, or from the Prometheus image. Run inside infra/monitoring.
promtool_run() {
  if command -v promtool > /dev/null 2>&1; then
    promtool "$@"
  else
    docker run -q --rm -i \
  -v "${REPO_ROOT}/infra/monitoring:/m:ro" \
  -w /m \
  --entrypoint promtool \
  "$PROMTOOL_IMAGE" "$@"
  fi
}

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

# Reads and checks Prometheus text exposition.
#   prom validate FILE NAME...         strict parse; every NAME must be present as a family
#   prom value FILE NAME [key=value..] sum of the samples of NAME whose labels match; exit 2 if none
PROM_JS='
const fs = require("fs");
const [cmd, file, ...rest] = process.argv.slice(1);
const text = fs.readFileSync(file, "utf8");
const NUMBER = /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|[-+]Inf|NaN)$/;
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+(\S+)$/;

function parseLabels(raw) {
  const out = {};
  if (raw === undefined || raw === "") return out;
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"(,|$)/y;
  let index = 0;
  while (index < raw.length) {
    re.lastIndex = index;
    const m = re.exec(raw);
    if (!m) throw new Error("bad label set: {" + raw + "}");
    out[m[1]] = m[2];
    index = re.lastIndex;
  }
  return out;
}

function parse() {
  const types = new Map();
  const samples = [];
  const errors = [];
  if (!text.endsWith("\n")) errors.push("exposition must end with a newline");
  text.split("\n").forEach((line, i) => {
    const where = "line " + (i + 1) + ": ";
    if (line === "") return;
    let m = /^# TYPE (\S+) (counter|gauge|histogram|summary|untyped)$/.exec(line);
    if (m) {
      if (types.has(m[1])) errors.push(where + "duplicate TYPE for " + m[1]);
      types.set(m[1], m[2]);
      return;
    }
    if (/^# HELP \S+ ?.*$/.test(line)) return;
    if (line.startsWith("#")) { errors.push(where + "unrecognised comment: " + line); return; }
    m = SAMPLE.exec(line);
    if (!m) { errors.push(where + "not a sample: " + line); return; }
    if (!NUMBER.test(m[3])) errors.push(where + "bad value: " + m[3]);
    try {
      samples.push({ name: m[1], labels: parseLabels(m[2]), value: Number(m[3].replace("+Inf", "Infinity")), line: i + 1 });
    } catch (e) { errors.push(where + e.message); }
  });
  return { types, samples, errors };
}

function familyOf(name, types) {
  if (types.has(name)) return name;
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    const base = name.endsWith(suffix) ? name.slice(0, -suffix.length) : undefined;
    if (base !== undefined && types.get(base) === "histogram") return base;
  }
  return undefined;
}

if (cmd === "validate") {
  const { types, samples, errors } = parse();
  const seenFamilies = new Set();
  for (const s of samples) {
    const family = familyOf(s.name, types);
    if (family === undefined) errors.push("line " + s.line + ": sample " + s.name + " has no TYPE line");
    else seenFamilies.add(family);
  }
  for (const [name, type] of types) {
    if (type !== "histogram") continue;
    const groups = new Map();
    for (const s of samples.filter((x) => x.name === name + "_bucket")) {
      const { le, ...others } = s.labels;
      if (le === undefined) { errors.push(name + "_bucket sample without le"); continue; }
      const key = JSON.stringify(others);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ le: le === "+Inf" ? Infinity : Number(le), value: s.value });
    }
    for (const [key, buckets] of groups) {
      for (let i = 1; i < buckets.length; i++) {
        if (!(buckets[i].le > buckets[i - 1].le)) errors.push(name + key + ": le bounds are not increasing");
        if (buckets[i].value < buckets[i - 1].value) errors.push(name + key + ": bucket counts are not cumulative");
      }
      const last = buckets[buckets.length - 1];
      if (last.le !== Infinity) errors.push(name + key + ": missing the +Inf bucket");
      const count = samples.find((x) => x.name === name + "_count" && JSON.stringify(x.labels) === key);
      if (!count || count.value !== last.value) errors.push(name + key + ": _count does not equal the +Inf bucket");
      if (!samples.some((x) => x.name === name + "_sum" && JSON.stringify(x.labels) === key)) errors.push(name + key + ": missing _sum");
    }
  }
  for (const required of rest) {
    if (!seenFamilies.has(required)) errors.push("required metric " + required + " is missing");
  }
  if (errors.length > 0) { console.error(errors.join("\n")); process.exit(1); }
} else if (cmd === "value") {
  const [name, ...filters] = rest;
  const { samples, errors } = parse();
  if (errors.length > 0) { console.error(errors.join("\n")); process.exit(1); }
  const wanted = filters.map((f) => f.split(/=(.*)/s));
  const matching = samples.filter((s) => s.name === name && wanted.every(([k, v]) => s.labels[k] === v));
  if (matching.length === 0) process.exit(2);
  console.log(matching.reduce((sum, s) => sum + s.value, 0));
} else {
  console.error("unknown command " + cmd);
  process.exit(1);
}
'
prom() { node -e "$PROM_JS" "$@"; }
prom_or_zero() { prom value "$@" 2> /dev/null || echo 0; }
scrape() { curl -sf -m 10 "$1/metrics" -o "$2"; } # scrape BASE FILE

# --------------------------------------------------------------------------
# 0. Preflight for the Docker-backed steps (same requirement as Phases 7 and 8).
# --------------------------------------------------------------------------
echo "== Phase 9 verify: preflight =="
if [ "$NEEDS_DOCKER" = "1" ]; then
  docker info --format '{{json .Runtimes}}' 2> /dev/null | grep -q '"runsc"' \
    || fail "the Docker runtime \"runsc\" (gVisor) is not registered (see Phase 7)"
  pass "Docker has the runsc runtime registered"
  docker image inspect live/sandbox-base:latest > /dev/null 2>&1 \
    || fail "sandbox image live/sandbox-base:latest not found (scripts/seed-sandbox-image.sh)"
  pass "sandbox image is present"
else
  note "P9_SKIP_REGRESSION=1 and P9_SKIP_STACK=1: no Docker needed"
fi
echo

# --------------------------------------------------------------------------
# 1. Regression: Phase 8 (which re-runs Phase 7, and through it Phases 0-6).
# --------------------------------------------------------------------------
echo "== Phase 9 verify: regression suite, Phases 0-8 =="
if [ "$SKIP_REGRESSION" = "1" ]; then
  SKIPPED+=("regression P0-P8")
  note "SKIPPED (P9_SKIP_REGRESSION=1)"
else
  bash phases/p8-scale/verify.sh
  pass "Phase 8 regression suite (which includes Phases 0 through 7)"
fi
echo

# --------------------------------------------------------------------------
# 2. Install, build, type-check, lint.
# --------------------------------------------------------------------------
echo "== Phase 9 verify: pnpm install, build, typecheck, lint =="
# shellcheck disable=SC2086
pnpm install --frozen-lockfile ${P9_PNPM_INSTALL_FLAGS:-} > "$LOG_DIR/install.log" 2>&1 \
  && pass "pnpm install --frozen-lockfile" \
  || { cat "$LOG_DIR/install.log"; fail "pnpm install --frozen-lockfile (is pnpm-lock.yaml out of date?)"; }
pnpm run build > "$LOG_DIR/build.log" 2>&1 \
  && pass "pnpm build" \
  || { cat "$LOG_DIR/build.log"; fail "pnpm build"; }
for artifact in packages/orchestrator/dist/logging.js packages/orchestrator/dist/metrics.js; do
  [ -f "$artifact" ] || fail "$artifact missing after build"
done
pass "Phase 9 modules were compiled (logging, metrics)"
pnpm run typecheck > "$LOG_DIR/typecheck.log" 2>&1 \
  && pass "pnpm typecheck (every package)" \
  || { cat "$LOG_DIR/typecheck.log"; fail "pnpm typecheck"; }
pnpm run lint:no-any > "$LOG_DIR/lint.log" 2>&1 \
  && pass "shared-types still has no 'any'" \
  || { cat "$LOG_DIR/lint.log"; fail "lint:no-any found an 'any' in shared-types"; }
echo

# --------------------------------------------------------------------------
# 3. Structured logger (in-process).
# --------------------------------------------------------------------------
echo "== Phase 9 verify: structured logging =="
LOGGING_JS='
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { createLogger, createLoggerFromEnv } = await import(pathToFileURL(process.env.REPO_ROOT + "/packages/orchestrator/dist/index.js").href);

function capture(options) {
  const lines = [];
  const logger = createLogger({ ...options, sink: { write: (level, line) => lines.push({ level, record: JSON.parse(line) }) }, now: () => new Date("2026-01-02T03:04:05.678Z") });
  return { logger, lines };
}

{
  const { logger, lines } = capture({ level: "info" });
  logger.debug("hidden");
  logger.info("hello", { a: 1 });
  logger.warn("careful");
  logger.error("boom");
  assert.deepEqual(lines.map((l) => l.level), ["info", "warn", "error"], "debug is below the info threshold");
  assert.deepEqual(lines[0].record, { ts: "2026-01-02T03:04:05.678Z", level: "info", msg: "hello", a: 1 });
  assert.equal(logger.isLevelEnabled("debug"), false);
}
{
  const { logger, lines } = capture({ level: "debug" });
  logger.debug("shown");
  assert.equal(lines.length, 1, "debug is written when the level is debug");
}
{
  const { logger, lines } = capture({ level: "info" });
  const circular = { name: "loop" };
  circular.self = circular;
  logger.info("secrets", {
    password: "hunter2", authorization: "Bearer abc", passwordHash: "scrypt$x", ORCHESTRATOR_AUTH_SECRET: "s3cret",
    accessToken: "t1", token: "t2", tokenTtlMs: 28800000,
    nested: { cookie: "sid=1", fine: "ok", deeper: [{ apiKey: "k" }] }, circular,
  });
  const record = lines[0].record;
  for (const key of ["password", "authorization", "passwordHash", "ORCHESTRATOR_AUTH_SECRET", "accessToken", "token"]) {
    assert.equal(record[key], "[REDACTED]", key + " is redacted");
  }
  assert.equal(record.tokenTtlMs, 28800000, "tokenTtlMs is a number, not a secret");
  assert.equal(record.nested.cookie, "[REDACTED]");
  assert.equal(record.nested.fine, "ok");
  assert.equal(record.nested.deeper[0].apiKey, "[REDACTED]", "redaction reaches into arrays");
  assert.equal(record.circular.self, "[Circular]");
  assert.ok(!JSON.stringify(record).match(/hunter2|s3cret|Bearer abc/), "no secret value appears anywhere in the line");
}
{
  const { logger, lines } = capture({ level: "info" });
  const error = new Error("disk full", { cause: new Error("ENOSPC") });
  error.code = "EIO";
  logger.error("write failed", { error, big: 10n, when: new Date("2026-01-01T00:00:00Z"), missing: undefined });
  const record = lines[0].record;
  assert.equal(record.error.name, "Error");
  assert.equal(record.error.message, "disk full");
  assert.equal(record.error.code, "EIO");
  assert.equal(record.error.cause.message, "ENOSPC");
  assert.ok(typeof record.error.stack === "string");
  assert.equal(record.big, "10");
  assert.equal(record.when, "2026-01-01T00:00:00.000Z");
  assert.ok(!("missing" in record));
}
{
  const { logger, lines } = capture({ level: "info", bindings: { service: "orchestrator" } });
  logger.info("forged", { ts: "1999", level: "debug", msg: "nope" });
  const record = lines[0].record;
  assert.equal(record.ts, "2026-01-02T03:04:05.678Z");
  assert.equal(record.level, "info");
  assert.equal(record.msg, "forged");
  assert.equal(record.field_ts, "1999", "a colliding field is kept under field_ts, never over ts");
  const child = logger.child({ requestId: "r-1" });
  child.info("scoped");
  assert.equal(lines[1].record.requestId, "r-1");
  assert.equal(lines[1].record.service, "orchestrator", "a child keeps its parent bindings");
  assert.ok(!("requestId" in lines[0].record), "the parent is unaffected by its child");
}
{
  const lines = [];
  const logger = createLoggerFromEnv({ LOG_LEVEL: "loud" }, {}, { write: (level, line) => lines.push({ level, record: JSON.parse(line) }) });
  assert.equal(lines.length, 1, "an invalid LOG_LEVEL is reported once");
  assert.equal(lines[0].record.msg, "logging.invalid_level");
  logger.debug("hidden");
  assert.equal(lines.length, 1, "and the level falls back to info");
}
console.log("logging checks ok");
'
REPO_ROOT="$REPO_ROOT" node --input-type=module -e "$LOGGING_JS" > "$LOG_DIR/logging.out" 2>&1 \
  && pass "levels, redaction, error serialisation, reserved keys, child loggers, bad LOG_LEVEL" \
  || { cat "$LOG_DIR/logging.out"; fail "structured logger checks"; }
echo

# --------------------------------------------------------------------------
# 4. /metrics through the real request handler (fake store and Docker).
# --------------------------------------------------------------------------
echo "== Phase 9 verify: /metrics endpoint (in-process) =="
METRICS_JS='
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const o = await import(pathToFileURL(process.env.REPO_ROOT + "/packages/orchestrator/dist/index.js").href);

const logLines = [];
const logger = o.createLogger({ level: "debug", sink: { write: (level, line) => logLines.push({ level, record: JSON.parse(line) }) } });
const store = Object.assign(new o.MemorySessionStore(), { touch: async () => true, ping: async () => true });
const t0 = Date.now();
// One session whose last heartbeat was 3700 s ago: past 2 x the 1800 s timeout.
await store.set("s1", { sessionId: "s1", ownerId: "dev-anonymous", containerId: "c1", image: "img", hostAgentPort: 1, status: "running", createdAt: t0 - 4_000_000, updatedAt: t0 - 3_700_000 });
let dockerDown = false;
const docker = {
  listManagedContainers: async () => {
    if (dockerDown) throw new Error("docker daemon unreachable");
    return [{ containerId: "c1", sessionId: "s1", image: "img", hostAgentPort: 1, labels: {}, createdAt: t0, status: "running" }];
  },
};
const now = () => Date.now();
const config = o.loadConfig({ ORCHESTRATOR_AUTH_MODE: "disabled" });
const auth = new o.Authenticator({ settings: { mode: "disabled" }, logger, now });

async function serve(bearerToken) {
  const metrics = o.createOrchestratorMetrics({ store, docker, idleTimeoutMs: 1_800_000, now, logger, replicaId: "verify", bearerToken });
  const server = http.createServer(o.createRequestHandler({ config, store, docker, auth, logger, now, metrics }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const get = async (path, headers = {}) => {
    const response = await fetch(base + path, { headers });
    return { status: response.status, text: await response.text(), headers: response.headers };
  };
  return { server, get };
}

const open = await serve(undefined);
await open.get("/healthz");
await open.get("/api/sessions");
await open.get("/does-not-exist");
const scraped = await open.get("/metrics", { "X-Request-Id": "verify-req-1" });
assert.equal(scraped.status, 200, "GET /metrics answers 200");
assert.equal(scraped.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
assert.equal(scraped.headers.get("x-request-id"), "verify-req-1", "a well-formed X-Request-Id is echoed");
assert.match((await open.get("/healthz")).headers.get("x-request-id"), /^[0-9a-f-]{36}$/, "otherwise one is generated");
assert.equal((await open.get("/healthz", { "X-Request-Id": "bad id with spaces" })).headers.get("x-request-id").includes(" "), false);
writeFileSync(process.env.OUT_DIR + "/metrics.txt", scraped.text);

const sample = (name, labels) => scraped.text.split("\n").find((l) => l.startsWith(name + (labels ?? " ")));
assert.equal(sample("active_sessions"), "active_sessions 1");
assert.equal(sample("container_count", "{status=\"running\"}"), "container_count{status=\"running\"} 1");
assert.equal(sample("container_count", "{status=\"error\"}"), "container_count{status=\"error\"} 0", "every status is always present, so the series never vanish");
assert.equal(sample("session_idle_timeout_seconds"), "session_idle_timeout_seconds 1800");
const idle = Number(sample("session_max_idle_seconds").split(" ")[1]);
assert.ok(idle > 3600 && idle < 3800, "session_max_idle_seconds reflects the stale session (" + idle + ")");
assert.ok(scraped.text.includes("request_duration_seconds_count{route=\"health\",method=\"GET\",status=\"200\"} 1"));
assert.ok(scraped.text.includes("request_duration_seconds_count{route=\"listSessions\",method=\"GET\",status=\"200\"} 1"));
assert.ok(scraped.text.includes("request_duration_seconds_count{route=\"not_found\",method=\"GET\",status=\"404\"} 1"), "unknown paths share one route label, not one label per path");
assert.ok(!scraped.text.includes("does-not-exist"), "raw paths never become label values");

const requestLogs = logLines.filter((l) => l.record.msg === "request");
assert.ok(requestLogs.filter((l) => l.record.route === "health" || l.record.route === "metrics").every((l) => l.level === "debug"), "probe requests log at debug");
assert.ok(requestLogs.some((l) => l.record.route === "listSessions" && l.level === "info" && typeof l.record.requestId === "string"), "API requests log at info with a requestId");

dockerDown = true;
const degraded = await open.get("/metrics");
assert.equal(degraded.status, 200, "a failing data source does not fail the scrape");
assert.ok(!/^container_count/m.test(degraded.text), "the gauge whose source failed is omitted, not reported as zero");
assert.ok(/^active_sessions 1$/m.test(degraded.text), "gauges with a working source are still reported");
assert.ok(degraded.text.includes("metrics_collect_failures_total{collector=\"container_count\"} 1"), "the failure is counted");
dockerDown = false;
open.server.close();

const closed = await serve("verify-token-0123456789");
assert.equal((await closed.get("/metrics")).status, 401, "token set: no credentials -> 401");
assert.equal((await closed.get("/metrics", { Authorization: "Bearer wrong-token-0123456789" })).status, 401, "token set: wrong token -> 401");
assert.equal((await closed.get("/metrics", { Authorization: "Bearer verify-token-0123456789" })).status, 200, "token set: right token -> 200");
assert.equal((await closed.get("/healthz")).status, 200, "/healthz stays open");
closed.server.close();

const noMetrics = http.createServer(o.createRequestHandler({ config, store, docker, auth, logger, now }));
await new Promise((resolve) => noMetrics.listen(0, "127.0.0.1", resolve));
const response = await fetch("http://127.0.0.1:" + noMetrics.address().port + "/metrics");
assert.equal(response.status, 404, "a context without metrics answers 404 rather than crashing");
noMetrics.close();
console.log("metrics checks ok");
'
REPO_ROOT="$REPO_ROOT" OUT_DIR="$LOG_DIR" node --input-type=module -e "$METRICS_JS" > "$LOG_DIR/metrics.out" 2>&1 \
  && pass "/metrics: values, labels, latency histogram, degraded scrape, bearer token, request ids" \
  || { cat "$LOG_DIR/metrics.out"; fail "in-process /metrics checks"; }

prom validate "$LOG_DIR/metrics.txt" active_sessions container_count request_duration_seconds \
  && pass "the exposition parses strictly and exposes active_sessions, container_count, request_duration_seconds" \
  || fail "the /metrics output is not valid Prometheus exposition (see above)"

# promtool's naming lint dislikes the "_count" suffix on a non-histogram. container_count is the
# name the Phase 9 plan requires, so that one finding is accepted; anything else is a failure.
LINT_OUT="$(promtool_run check metrics < "$LOG_DIR/metrics.txt" 2>&1 || true)"
LINT_REST="$(printf '%s\n' "$LINT_OUT" | grep -v '^container_count non-histogram and non-summary metrics should not have "_count" suffix$' | grep -v '^$' || true)"
if [ -n "$LINT_REST" ]; then
  echo "$LINT_REST"
  fail "promtool check metrics reported problems"
fi
pass "promtool check metrics accepts the output (only the accepted container_count naming note remains)"
echo

# --------------------------------------------------------------------------
# 5. Prometheus configuration, alert rules and their unit tests.
# --------------------------------------------------------------------------
echo "== Phase 9 verify: Prometheus config and alert rules =="
for file in prometheus.yml alerts.yml alerts.test.yml; do
  [ -f "infra/monitoring/$file" ] || fail "infra/monitoring/$file is missing"
done
(cd infra/monitoring && promtool_run check config prometheus.yml) > "$LOG_DIR/promcfg.log" 2>&1 \
  && pass "prometheus.yml is valid and finds alerts.yml" \
  || { cat "$LOG_DIR/promcfg.log"; fail "promtool check config"; }
(cd infra/monitoring && promtool_run check rules alerts.yml) > "$LOG_DIR/promrules.log" 2>&1 \
  && pass "alerts.yml is valid" \
  || { cat "$LOG_DIR/promrules.log"; fail "promtool check rules"; }
for alert in SandboxContainerCpuHigh SessionIdlePastTwiceTimeout; do
  grep -q "alert: ${alert}$" infra/monitoring/alerts.yml || fail "alert ${alert} is not defined"
done
grep -q "^scrape_configs:" infra/monitoring/prometheus.yml && grep -q "job_name: orchestrator" infra/monitoring/prometheus.yml \
  || fail "prometheus.yml does not scrape the orchestrator"
pass "the CPU and idle-session alerts are defined, and the orchestrator is a scrape target"
(cd infra/monitoring && promtool_run test rules alerts.test.yml) > "$LOG_DIR/promtest.log" 2>&1 \
  && pass "alert unit tests: CPU > 90% fires only after 5 minutes; a session idle > 2x timeout fires; near-misses stay quiet" \
  || { cat "$LOG_DIR/promtest.log"; fail "promtool test rules"; }
echo

# --------------------------------------------------------------------------
# 6. GitHub Actions workflow.
# --------------------------------------------------------------------------
echo "== Phase 9 verify: CI workflow =="
CI_FILE=".github/workflows/ci.yml"
[ -f "$CI_FILE" ] || fail "$CI_FILE is missing"
if python3 -c 'import yaml' > /dev/null 2>&1; then
  python3 - "$CI_FILE" << 'PY' || fail "the CI workflow is malformed (see above)"
import sys, yaml
workflow = yaml.safe_load(open(sys.argv[1]))
triggers = workflow.get(True, workflow.get("on"))  # YAML 1.1 reads a bare `on` as True
problems = []
for trigger in ("pull_request", "push"):
    if trigger not in triggers:
        problems.append(f"workflow does not run on {trigger}")
jobs = workflow.get("jobs", {})
for job in ("static", "operability", "regression"):
    if job not in jobs:
        problems.append(f"job {job} is missing")
def commands(job):
    return "\n".join(str(step.get("run", "")) for step in jobs.get(job, {}).get("steps", []))
for needle in ("lint:no-any", "pnpm run build", "typecheck"):
    if needle not in commands("static"):
        problems.append(f"job static does not run {needle}")
if "p9-operability/verify.sh" not in commands("operability") or "p9-operability/verify.sh" not in commands("regression"):
    problems.append("operability and regression must both run the Phase 9 gate")
if "P9_SKIP_REGRESSION" in commands("regression") or "P9_SKIP_STACK" in commands("regression"):
    problems.append("the regression job must run the gate without skips")
for job in ("operability", "regression"):
    if "static" not in (jobs[job].get("needs") or []):
        problems.append(f"job {job} should wait for static")
if problems:
    print("\n".join(problems))
    sys.exit(1)
PY
  pass "ci.yml parses; runs on push and pull_request; static, operability and full regression jobs are wired"
else
  for needle in "pull_request:" "push:" "lint:no-any" "pnpm run build" "typecheck" "p9-operability/verify.sh"; do
    grep -q -- "$needle" "$CI_FILE" || fail "ci.yml does not contain '$needle'"
  done
  note "python3 'yaml' is not installed: ci.yml was checked with grep only"
  pass "ci.yml mentions both triggers, lint, build, typecheck and the Phase 9 gate"
fi
echo

# --------------------------------------------------------------------------
# 7. /metrics on the real two-replica stack, with a real sandbox.
# --------------------------------------------------------------------------
echo "== Phase 9 verify: /metrics on the live two-replica stack =="
if [ "$SKIP_STACK" = "1" ]; then
  SKIPPED+=("live stack")
  note "SKIPPED (P9_SKIP_STACK=1)"
else
  rand() { node -e 'console.log(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }
  export POSTGRES_PASSWORD="pg$(rand 12)"
  export REDIS_PASSWORD="rd$(rand 12)"
  export ORCHESTRATOR_AUTH_SECRET="$(rand 32)"
  ALICE_PASSWORD="alice-$(rand 6)"
  ORCHESTRATOR_AUTH_USERS="$(ALICE_PASSWORD="$ALICE_PASSWORD" node --input-type=module -e '
    const { hashPassword } = await import("./packages/orchestrator/dist/index.js");
    console.log(JSON.stringify([{ id: "u_alice", username: "alice", passwordHash: await hashPassword(process.env.ALICE_PASSWORD) }]));
  ')"
  export ORCHESTRATOR_AUTH_USERS

  COMPOSE_LOGS_ON_FAIL=1
  for port in "$PROD_HTTP_PORT" "$ORCHESTRATOR_LB_PORT" "$ORCHESTRATOR_1_PORT" "$ORCHESTRATOR_2_PORT"; do
    if curl -s -m 1 -o /dev/null "http://127.0.0.1:${port}/"; then
      fail "something already answers on port ${port}; set the P9_* port variables to free ports"
    fi
  done
  bash scripts/ensure-proxy-network.sh > /dev/null 2>&1 || fail "scripts/ensure-proxy-network.sh failed"
  STACK_STARTED=1
  $COMPOSE up -d orchestrator-1 orchestrator-2 orchestrator-lb > "$LOG_DIR/compose-up.log" 2>&1 \
    && pass "docker compose up -d (two orchestrators, load balancer, Redis, Postgres, Traefik)" \
    || { cat "$LOG_DIR/compose-up.log"; fail "docker compose up -d"; }
  wait_until 240 url_ok "${O1}/healthz" || fail "orchestrator-1 never became healthy"
  wait_until 240 url_ok "${O2}/healthz" || fail "orchestrator-2 never became healthy"
  wait_until 60 url_ok "${LB}/healthz" || fail "the orchestrator load balancer never answered"
  pass "both replicas and the load balancer answer"

  expect_status 200 "alice signs in" "$O1" POST /api/auth/login "" "{\"username\":\"alice\",\"password\":\"${ALICE_PASSWORD}\"}"
  ALICE_TOKEN="$(jget token)"

  scrape "$O1" "$LOG_DIR/o1-before.txt" || fail "GET ${O1}/metrics failed"
  scrape "$O2" "$LOG_DIR/o2-before.txt" || fail "GET ${O2}/metrics failed"
  for file in o1-before o2-before; do
    prom validate "$LOG_DIR/$file.txt" active_sessions container_count request_duration_seconds session_max_idle_seconds session_idle_timeout_seconds \
      || fail "$file: invalid exposition (see above)"
  done
  pass "both replicas expose valid active_sessions, container_count and request_duration_seconds"
  [ "$(prom value "$LOG_DIR/o1-before.txt" session_idle_timeout_seconds)" = "600" ] \
    && pass "session_idle_timeout_seconds is 600 (SESSION_IDLE_TIMEOUT_MS=600000)" \
    || fail "session_idle_timeout_seconds does not match SESSION_IDLE_TIMEOUT_MS"

  SESSIONS_BEFORE="$(prom value "$LOG_DIR/o1-before.txt" active_sessions)"
  CONTAINERS_BEFORE="$(prom value "$LOG_DIR/o1-before.txt" container_count status=running)"
  CREATES_BEFORE="$(prom_or_zero "$LOG_DIR/o1-before.txt" request_duration_seconds_count route=createSession status=201)"

  expect_status 201 "alice creates a session through replica 1" "$O1" POST /api/sessions "$ALICE_TOKEN"
  SID="$(jget sessionId)"
  CID="$(jget containerId)"
  CREATED_SESSION_IDS+=("$SID")

  metric_is() { # metric_is BASE FILE EXPECTED NAME [labels...]
    local base="$1" file="$2" expected="$3"
    shift 3
    scrape "$base" "$file" && [ "$(prom value "$file" "$@" 2> /dev/null || echo none)" = "$expected" ]
  }
  wait_until 20 metric_is "$O1" "$LOG_DIR/o1-after.txt" "$((SESSIONS_BEFORE + 1))" active_sessions \
    && pass "active_sessions rose by one on replica 1" || fail "active_sessions did not rise on replica 1"
  wait_until 20 metric_is "$O2" "$LOG_DIR/o2-after.txt" "$((SESSIONS_BEFORE + 1))" active_sessions \
    && pass "replica 2 reports the same count (shared store)" || fail "replica 2 does not see the new session"
  wait_until 20 metric_is "$O1" "$LOG_DIR/o1-after.txt" "$((CONTAINERS_BEFORE + 1))" container_count status=running \
    && pass "container_count{status=running} rose by one: the sandbox is counted" || fail "container_count did not count the new sandbox"
  wait_until 20 metric_is "$O1" "$LOG_DIR/o1-after.txt" "$((CREATES_BEFORE + 1))" request_duration_seconds_count route=createSession status=201 \
    && pass "request_duration_seconds recorded the create request" || fail "request_duration_seconds did not record POST /api/sessions"
  CREATE_SUM="$(prom value "$LOG_DIR/o1-after.txt" request_duration_seconds_sum route=createSession status=201)"
  awk -v v="$CREATE_SUM" 'BEGIN { exit !(v > 0) }' && pass "and its recorded duration is positive (${CREATE_SUM} s in total)" || fail "createSession duration sum is not positive"
  prom validate "$LOG_DIR/o1-after.txt" active_sessions container_count request_duration_seconds || fail "exposition invalid after a request"
  IDLE_NOW="$(prom value "$LOG_DIR/o1-after.txt" session_max_idle_seconds)"
  awk -v v="$IDLE_NOW" 'BEGIN { exit !(v >= 0 && v < 600) }' \
    && pass "session_max_idle_seconds is ${IDLE_NOW} s for a fresh session, far from the 1200 s alert line" \
    || fail "session_max_idle_seconds is ${IDLE_NOW} for a brand-new session"

  # The CPU alert selects sandboxes by the container_label_live_session_id label and measures
  # against the CPU quota; both must really be on a sandbox for the alert to ever match.
  [ "$(docker inspect -f '{{index .Config.Labels "live.session-id"}}' "$CID")" = "$SID" ] \
    && pass "the sandbox carries the live.session-id label the CPU alert selects on" \
    || fail "the sandbox container has no live.session-id label"
  [ "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$CID")" -gt 0 ] \
    && pass "the sandbox has a CPU limit, so the CPU alert has a quota to measure against" \
    || fail "the sandbox has no CPU limit"

  expect_status 200 "alice ends the session through replica 2" "$O2" DELETE "/api/sessions/${SID}" "$ALICE_TOKEN"
  wait_until 20 metric_is "$O1" "$LOG_DIR/o1-end.txt" "$SESSIONS_BEFORE" active_sessions \
    && pass "active_sessions fell back" || fail "active_sessions did not fall after DELETE"
  wait_until 20 metric_is "$O1" "$LOG_DIR/o1-end.txt" "$CONTAINERS_BEFORE" container_count status=running \
    && pass "container_count fell back" || fail "container_count did not fall after DELETE"
  COMPOSE_LOGS_ON_FAIL=""
fi
echo

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  note "Skipped: ${SKIPPED[*]}. This was NOT a full Phase 9 pass."
  echo "Phase 9 checks passed (with skips)."
else
  note "The CPU alert is proven by promtool unit tests on synthetic series, not by burning CPU in a live sandbox under cAdvisor."
  note "Prometheus and cAdvisor are not started by this gate; run Prometheus with infra/monitoring/prometheus.yml and cAdvisor on :8081."
  echo "All Phase 9 checks passed."
fi