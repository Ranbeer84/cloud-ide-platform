#!/usr/bin/env node
/**
 * Phase 7 authentication and ownership check. Needs no Docker and no Redis:
 * it runs the real orchestrator request handler against an in-memory store, a
 * fake Docker and a fake sandbox agent, so every assertion is deterministic.
 *
 * Proves: protected routes answer 401 without valid credentials; tokens cannot
 * be forged, replayed after expiry, or used after the account is removed;
 * login does not reveal which usernames exist and is throttled; accounts can
 * only see, heartbeat and delete their own sessions; the per-account cap holds;
 * disabled mode works only on loopback; v1 session records are discarded.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = (relative) => pathToFileURL(path.join(repoRoot, "packages/orchestrator/dist", relative)).href;

const {
  Authenticator,
  TokenService,
  createRequestHandler,
  hashPassword,
  verifyPassword,
  loadConfig,
  ConfigError,
  MemorySessionStore,
  ORPHAN_OWNER_ID,
} = await import(dist("index.js"));
const { hashToSessionRecord, sessionRecordToHash, SESSION_SCHEMA_VERSION } = await import(dist("sessionStore/sessionTypes.js"));

function pass(message) {
  console.log(`  PASS: ${message}`);
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  pass(message);
}

const SECRET = "p7-test-secret-p7-test-secret-p7-test-secret";
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;
const silentLogger = { info() {}, warn() {}, error() {} };

/* ---------------------------------------------------------------- fakes */

/** A sandbox agent that only answers /health, so createSession's readiness probe succeeds. */
async function startFakeAgent() {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

function makeFakeDocker(agentPort) {
  const running = new Map();
  let counter = 0;
  return {
    running,
    async spawnContainer(options) {
      counter += 1;
      const containerId = `fake-container-${counter}`;
      running.set(containerId, options.sessionId);
      return {
        containerId,
        sessionId: options.sessionId,
        image: options.image,
        hostAgentPort: agentPort,
        labels: {},
        createdAt: Date.now(),
        status: "running",
      };
    },
    async inspectContainer(containerId) {
      return { containerId, running: running.has(containerId), oomKilled: false, exitCode: null, status: "running" };
    },
    async stopContainer(containerId) {
      running.delete(containerId);
    },
    async listManagedContainers() {
      return [...running.entries()].map(([containerId, sessionId]) => ({
        containerId,
        sessionId,
        image: "fake",
        hostAgentPort: agentPort,
        labels: {},
        createdAt: Date.now(),
        status: "running",
      }));
    },
  };
}

/** The orchestrator store contract on top of the Phase 1 in-memory store. */
function makeStore() {
  const inner = new MemorySessionStore();
  return {
    get: (id) => inner.get(id),
    set: (id, record) => inner.set(id, record),
    delete: (id) => inner.delete(id),
    list: () => inner.list(),
    async touch(id, at) {
      const record = await inner.get(id);
      if (!record) {
        return false;
      }
      await inner.set(id, { ...record, updatedAt: at });
      return true;
    },
    async ping() {
      return true;
    },
  };
}

const PASSWORDS = { alice: "alice-correct-horse", bob: "bob-battery-staple" };
const USERS = [
  { id: "u_alice", username: "alice", passwordHash: await hashPassword(PASSWORDS.alice) },
  { id: "u_bob", username: "bob", passwordHash: await hashPassword(PASSWORDS.bob) },
];

function envFor(overrides = {}) {
  return {
    ORCHESTRATOR_HOST: "127.0.0.1",
    ORCHESTRATOR_AUTH_SECRET: SECRET,
    ORCHESTRATOR_AUTH_USERS: JSON.stringify(USERS),
    MAX_SESSIONS_PER_USER: "2",
    ...overrides,
  };
}

async function startApi({ authMode = "required", users = USERS } = {}) {
  const agent = await startFakeAgent();
  const docker = makeFakeDocker(agent.port);
  const store = makeStore();
  const config = loadConfig(authMode === "required" ? envFor() : envFor({ ORCHESTRATOR_AUTH_MODE: "disabled" }));
  const auth = new Authenticator({
    settings:
      authMode === "required"
        ? { mode: "required", secret: SECRET, users, tokenTtlMs: config.authTokenTtlMs }
        : { mode: "disabled" },
    logger: silentLogger,
    now,
  });
  const ctx = { config, store, docker, auth, logger: silentLogger, now };
  const server = createServer(createRequestHandler(ctx));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    docker,
    store,
    async close() {
      server.closeAllConnections();
      agent.server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => agent.server.close(resolve));
    },
  };
}

async function call(base, method, route, { token, headers, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, headers: response.headers };
}

async function login(base, username) {
  const result = await call(base, "POST", "/api/auth/login", { body: { username, password: PASSWORDS[username] } });
  if (result.status !== 200) {
    throw new Error(`login for ${username} failed with ${result.status}`);
  }
  return result.json.token;
}

/* --------------------------------------------------------------- checks */

async function checkConfigAndSecrets() {
  console.log("== A. configuration refuses insecure setups ==");
  const rejects = (env, fragment) => {
    try {
      loadConfig(env);
    } catch (error) {
      return error instanceof ConfigError && error.problems.some((problem) => problem.includes(fragment));
    }
    return false;
  };

  assert(rejects({ ORCHESTRATOR_AUTH_USERS: JSON.stringify(USERS) }, "ORCHESTRATOR_AUTH_SECRET"), "required mode refuses to start without a signing secret");
  assert(rejects(envFor({ ORCHESTRATOR_AUTH_SECRET: "too-short" }), "at least 32"), "a short signing secret is refused");
  assert(rejects({ ORCHESTRATOR_AUTH_SECRET: SECRET }, "ORCHESTRATOR_AUTH_USERS"), "required mode refuses to start with no accounts");
  assert(rejects(envFor({ ORCHESTRATOR_AUTH_USERS: "not json" }), "not valid JSON"), "malformed account JSON is refused");
  assert(
    rejects(envFor({ ORCHESTRATOR_AUTH_USERS: JSON.stringify([{ id: "a:b", username: "x", passwordHash: USERS[0].passwordHash }]) }), ".id must match"),
    'an account id containing ":" is refused (it could impersonate the orphan owner)',
  );
  assert(
    rejects(envFor({ ORCHESTRATOR_AUTH_USERS: JSON.stringify([{ id: "u1", username: "x", passwordHash: "plaintext-password" }]) }), "passwordHash"),
    "a plaintext password where a hash belongs is refused",
  );
  assert(
    rejects(envFor({ ORCHESTRATOR_AUTH_USERS: JSON.stringify([USERS[0], { ...USERS[1], username: "ALICE" }]) }), "used twice"),
    "duplicate usernames (case-insensitive) are refused",
  );
  assert(rejects({ ORCHESTRATOR_AUTH_MODE: "disabled", ORCHESTRATOR_HOST: "0.0.0.0" }, "loopback"), "auth cannot be disabled on a non-loopback listen address");
  assert(loadConfig({ ORCHESTRATOR_AUTH_MODE: "disabled", ORCHESTRATOR_HOST: "127.0.0.1" }).authMode === "disabled", "auth can be disabled on loopback (development only)");
  assert(loadConfig(envFor()).authMode === "required", "authentication is required by default");
}

async function checkPasswordsAndTokens() {
  console.log("== B. password hashes and tokens ==");
  assert(await verifyPassword(PASSWORDS.alice, USERS[0].passwordHash), "the right password verifies");
  assert(!(await verifyPassword("wrong", USERS[0].passwordHash)), "a wrong password does not verify");
  assert(!(await verifyPassword("anything", "scrypt$1$1$1$AAAA$AAAA")), "a malformed or out-of-bounds hash never verifies");
  assert((await hashPassword("same")) !== (await hashPassword("same")), "hashing the same password twice gives different hashes (random salt)");

  const tokens = new TokenService(SECRET, 60_000, now);
  const { token } = tokens.issue({ id: "u_alice", username: "alice" });
  assert(tokens.verify(token)?.sub === "u_alice", "a freshly issued token verifies");

  const [version, payload, signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ sub: "u_bob", usr: "bob", iat: Date.now(), exp: Date.now() + 60_000 })).toString("base64url");
  assert(tokens.verify(`${version}.${forgedPayload}.${signature}`) === undefined, "editing the payload (alice -> bob) invalidates the signature");
  assert(tokens.verify(`${version}.${payload}.${signature.slice(0, -2)}AA`) === undefined, "a tampered signature is rejected");
  assert(new TokenService("another-secret-another-secret-another!", 60_000, now).verify(token) === undefined, "a token signed with a different secret is rejected");
  assert(tokens.verify(`none.${payload}.`) === undefined && tokens.verify("garbage") === undefined && tokens.verify("a.b.c.d") === undefined, "garbage and alg-none style tokens are rejected");

  clockOffsetMs = 61_000;
  assert(tokens.verify(token) === undefined, "an expired token is rejected");
  clockOffsetMs = 0;
}

async function checkUnauthenticated(api) {
  console.log("== C. unauthenticated calls return 401 ==");
  const aliceToken = await login(api.base, "alice");
  const created = await call(api.base, "POST", "/api/sessions", { token: aliceToken });
  const id = created.json.sessionId;

  const protectedCalls = [
    ["POST", "/api/sessions"],
    ["GET", "/api/sessions"],
    ["GET", `/api/sessions/${id}`],
    ["POST", `/api/sessions/${id}/heartbeat`],
    ["DELETE", `/api/sessions/${id}`],
    ["GET", "/api/auth/me"],
  ];
  for (const [method, route] of protectedCalls) {
    const result = await call(api.base, method, route);
    assert(
      result.status === 401 && result.json?.error?.code === "unauthorized" && /Bearer/.test(result.headers.get("www-authenticate") ?? ""),
      `${method} ${route.replace(id, ":id")} without a token -> 401 + WWW-Authenticate`,
    );
  }

  const badHeaders = [
    ["a Basic credential", { Authorization: "Basic YWxpY2U6cGFzcw==" }],
    ["a garbage bearer token", { Authorization: "Bearer not.a.token" }],
    ["an empty bearer token", { Authorization: "Bearer " }],
  ];
  for (const [label, headers] of badHeaders) {
    const result = await call(api.base, "GET", "/api/sessions", { headers });
    assert(result.status === 401, `${label} -> 401`);
  }

  const stillThere = await call(api.base, "GET", `/api/sessions/${id}`, { token: aliceToken });
  assert(stillThere.status === 200 && api.docker.running.size === 1, "the rejected DELETE did not touch the session or its container");

  const health = await call(api.base, "GET", "/healthz");
  assert(health.status === 200, "/healthz stays public for liveness probes");
  const unknown = await call(api.base, "GET", "/api/nope");
  assert(unknown.status === 404, "an unknown route is 404, not 401");
  const preflight = await fetch(`${api.base}/api/sessions`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
  assert(preflight.status === 204 && /Authorization/.test(preflight.headers.get("access-control-allow-headers") ?? ""), "CORS preflight succeeds and allows the Authorization header");

  await call(api.base, "DELETE", `/api/sessions/${id}`, { token: aliceToken });
}

async function checkLogin(api) {
  console.log("== D. login ==");
  const wrongPassword = await call(api.base, "POST", "/api/auth/login", { body: { username: "alice", password: "nope" } });
  const unknownUser = await call(api.base, "POST", "/api/auth/login", { body: { username: "nobody", password: "nope" } });
  assert(
    wrongPassword.status === 401 && unknownUser.status === 401 && JSON.stringify(wrongPassword.json) === JSON.stringify(unknownUser.json),
    "a wrong password and an unknown username are indistinguishable",
  );
  const missing = await call(api.base, "POST", "/api/auth/login", { body: { username: "alice" } });
  assert(missing.status === 400, "a login with no password is a 400");
  const upper = await call(api.base, "POST", "/api/auth/login", { body: { username: "ALICE", password: PASSWORDS.alice } });
  assert(upper.status === 200, "usernames are case-insensitive");

  const me = await call(api.base, "GET", "/api/auth/me", { token: upper.json.token });
  assert(me.json?.user?.id === "u_alice", "/api/auth/me reports the token's owner");

  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastStatus = (await call(api.base, "POST", "/api/auth/login", { body: { username: "mallory", password: `guess-${attempt}` } })).status;
  }
  assert(lastStatus === 429, "the 6th wrong guess in a row is throttled (429)");
  const aliceStillIn = await call(api.base, "POST", "/api/auth/login", { body: { username: "alice", password: PASSWORDS.alice } });
  assert(aliceStillIn.status === 200, "throttling mallory does not lock out alice");
}

async function checkOwnership(api) {
  console.log("== E. accounts only reach their own sessions ==");
  const aliceToken = await login(api.base, "alice");
  const bobToken = await login(api.base, "bob");

  const aliceSession = await call(api.base, "POST", "/api/sessions", { token: aliceToken });
  const bobSession = await call(api.base, "POST", "/api/sessions", { token: bobToken });
  assert(aliceSession.status === 201 && bobSession.status === 201, "alice and bob each create a session");
  const aliceId = aliceSession.json.sessionId;
  const bobId = bobSession.json.sessionId;
  assert((await api.store.get(aliceId)).ownerId === "u_alice", "the stored record names the creating account as owner");

  const aliceList = await call(api.base, "GET", "/api/sessions", { token: aliceToken });
  assert(aliceList.json.sessions.length === 1 && aliceList.json.sessions[0].sessionId === aliceId, "alice's list contains only her session");
  const bobList = await call(api.base, "GET", "/api/sessions", { token: bobToken });
  assert(bobList.json.sessions.length === 1 && bobList.json.sessions[0].sessionId === bobId, "bob's list contains only his session");

  const bobReadsAlice = await call(api.base, "GET", `/api/sessions/${aliceId}`, { token: bobToken });
  const bobReadsMissing = await call(api.base, "GET", "/api/sessions/sdoesnotexist0000", { token: bobToken });
  assert(
    bobReadsAlice.status === 404 && bobReadsMissing.status === 404 && bobReadsAlice.json.error.code === bobReadsMissing.json.error.code,
    "bob viewing alice's session gets the same 404 as a session that does not exist",
  );
  const bobBeats = await call(api.base, "POST", `/api/sessions/${aliceId}/heartbeat`, { token: bobToken });
  assert(bobBeats.status === 404, "bob cannot heartbeat alice's session");
  const before = (await api.store.get(aliceId)).updatedAt;
  const bobDeletes = await call(api.base, "DELETE", `/api/sessions/${aliceId}`, { token: bobToken });
  assert(bobDeletes.status === 404, "bob cannot delete alice's session");
  assert(
    api.docker.running.has(aliceSession.json.containerId) && (await api.store.get(aliceId)) !== undefined && (await api.store.get(aliceId)).updatedAt === before,
    "alice's container, record and activity time are untouched by bob's attempts",
  );

  const aliceReads = await call(api.base, "GET", `/api/sessions/${aliceId}`, { token: aliceToken });
  const aliceBeats = await call(api.base, "POST", `/api/sessions/${aliceId}/heartbeat`, { token: aliceToken });
  assert(aliceReads.status === 200 && aliceBeats.status === 200, "alice can still read and heartbeat her own session");

  const aliceDeletes = await call(api.base, "DELETE", `/api/sessions/${aliceId}`, { token: aliceToken });
  assert(aliceDeletes.status === 200 && !api.docker.running.has(aliceSession.json.containerId), "alice can delete her session, and its container is stopped");
  assert((await call(api.base, "GET", `/api/sessions/${aliceId}`, { token: aliceToken })).status === 404, "the deleted session is gone");
  assert(api.docker.running.has(bobSession.json.containerId), "bob's session is unaffected");
  await call(api.base, "DELETE", `/api/sessions/${bobId}`, { token: bobToken });
}

async function checkCap(api) {
  console.log("== F. per-account session cap ==");
  const aliceToken = await login(api.base, "alice");
  const bobToken = await login(api.base, "bob");
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    ids.push((await call(api.base, "POST", "/api/sessions", { token: aliceToken })).json.sessionId);
  }
  const third = await call(api.base, "POST", "/api/sessions", { token: aliceToken });
  assert(third.status === 429 && third.json.error.code === "user_capacity_reached", "alice's 3rd session is refused (limit 2)");
  const bob = await call(api.base, "POST", "/api/sessions", { token: bobToken });
  assert(bob.status === 201, "alice hitting her cap does not stop bob");
  for (const id of ids) {
    await call(api.base, "DELETE", `/api/sessions/${id}`, { token: aliceToken });
  }
  await call(api.base, "DELETE", `/api/sessions/${bob.json.sessionId}`, { token: bobToken });
}

async function checkRemovedAccount() {
  console.log("== G. a removed account's tokens stop working ==");
  const api = await startApi();
  const bobToken = await login(api.base, "bob");
  await api.close();

  const reduced = await startApi({ users: [USERS[0]] });
  const result = await call(reduced.base, "GET", "/api/sessions", { token: bobToken });
  assert(result.status === 401, "bob's still-unexpired token is rejected once his account is gone");
  await reduced.close();
}

async function checkDisabledMode() {
  console.log("== H. disabled mode (loopback development) ==");
  const api = await startApi({ authMode: "disabled" });
  const created = await call(api.base, "POST", "/api/sessions");
  assert(created.status === 201 && (await api.store.get(created.json.sessionId)).ownerId === "dev-anonymous", "without auth, sessions belong to the shared anonymous account");
  const login404 = await call(api.base, "POST", "/api/auth/login", { body: { username: "alice", password: "x" } });
  assert(login404.status === 404 && login404.json.error.code === "auth_disabled", "login is unavailable when auth is disabled");
  await call(api.base, "DELETE", `/api/sessions/${created.json.sessionId}`);
  await api.close();
}

function checkSchema() {
  console.log("== I. session schema v2 and migration ==");
  const record = {
    sessionId: "s1",
    ownerId: "u_alice",
    containerId: "c1",
    image: "img",
    hostAgentPort: 1234,
    status: "running",
    createdAt: 1,
    updatedAt: 2,
  };
  assert(SESSION_SCHEMA_VERSION === 2, "the persisted schema version was bumped to 2");
  assert(JSON.stringify(hashToSessionRecord(sessionRecordToHash(record))) === JSON.stringify(record), "a v2 record round-trips with its owner");
  const v1 = { ...sessionRecordToHash(record), schemaVersion: "1" };
  delete v1.ownerId;
  assert(hashToSessionRecord(v1) === undefined, "a v1 record (no owner) is unreadable, so the store discards it instead of guessing an owner");
  assert(hashToSessionRecord({ ...sessionRecordToHash(record), ownerId: "" }) === undefined, "a v2 record with an empty owner is unreadable");
  assert(hashToSessionRecord({ ...sessionRecordToHash(record), ownerId: "bad owner!" }) === undefined, "a v2 record with a malformed owner is unreadable");
  assert(hashToSessionRecord({ ...sessionRecordToHash(record), ownerId: ORPHAN_OWNER_ID }) !== undefined, "the reserved orphan owner is accepted");
}

async function main() {
  await checkConfigAndSecrets();
  console.log();
  await checkPasswordsAndTokens();
  console.log();
  const api = await startApi();
  try {
    await checkUnauthenticated(api);
    console.log();
    await checkLogin(api);
    console.log();
    await checkOwnership(api);
    console.log();
    await checkCap(api);
  } finally {
    await api.close();
  }
  console.log();
  await checkRemovedAccount();
  console.log();
  await checkDisabledMode();
  console.log();
  checkSchema();
  console.log();
  console.log("All Phase 7 auth checks passed.");
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}