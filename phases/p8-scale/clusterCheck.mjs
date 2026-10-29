#!/usr/bin/env node
/**
 * Phase 8 cluster checks. Run by verify.sh against a live multi-replica stack.
 *
 *   node clusterCheck.mjs sockets    Socket.IO routing across two streaming replicas
 *   node clusterCheck.mjs restart    rolling restart of one streaming replica
 *   node clusterCheck.mjs postgres   Postgres schema, accounts, history, audit, durability
 *   node clusterCheck.mjs store      two orchestrator session stores over one Redis + Postgres
 *
 * Environment
 *   STREAMING_A_URL / STREAMING_B_URL   direct URLs of replica 1 and replica 2
 *   STREAMING_LB_URL, STREAMING_LB_HOST load balancer URL and the Host header it routes on
 *   RESTART_CMD                         shell command that restarts replica 1 (restart mode)
 *   DATABASE_URL                        Postgres URL (postgres and store modes)
 *   REDIS_URL, REDIS_KEY_PREFIX         Redis URL and key prefix (store mode)
 *   RESTART_DB_CMD                      shell command that restarts Postgres (postgres mode, optional)
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromWeb = createRequire(path.join(repoRoot, "packages/web/package.json"));
const { io } = requireFromWeb("socket.io-client");

const STREAMING_A_URL = process.env.STREAMING_A_URL ?? "http://127.0.0.1:4201";
const STREAMING_B_URL = process.env.STREAMING_B_URL ?? "http://127.0.0.1:4202";
const STREAMING_LB_URL = process.env.STREAMING_LB_URL ?? "";
const STREAMING_LB_HOST = process.env.STREAMING_LB_HOST ?? "streaming.localhost";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (message) => console.log(`  PASS: ${message}`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  pass(message);
}

const openSockets = new Set();

function connect(url, { reconnection = false, hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection,
      reconnectionDelay: 200,
      reconnectionDelayMax: 1000,
      ...(hostHeader ? { extraHeaders: { Host: hostHeader } } : {}),
    });
    openSockets.add(socket);
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 8000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      if (!reconnection) {
        clearTimeout(timer);
        reject(new Error(`connect_error from ${url}: ${error.message}`));
      }
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event} within ${timeoutMs}ms`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/** Resolves with the first event of this name matching `predicate`, or rejects on timeout. */
function waitFor(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    function handler(payload) {
      if (predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    }
    socket.on(event, handler);
  });
}

async function health(url, hostHeader) {
  const response = await fetch(`${url}/health`, { headers: hostHeader ? { Host: hostHeader } : {} });
  return { status: response.status, body: await response.json() };
}

const TREE = {
  name: "",
  path: "",
  kind: "directory",
  children: [{ name: "app.js", path: "app.js", kind: "file" }],
};

/** One host on `hostUrl`, one viewer on `viewerUrl`: everything the viewer sees must match the host. */
async function exerciseDirection(label, hostUrl, viewerUrl) {
  console.log(`-- ${label}`);
  const host = await connect(hostUrl);
  const created = await emitAck(host, "session:create", { topic: `p8-${label}` });
  assert(created.ok === true, `${label}: host created a session`);
  const { id: sessionId, code } = created.session;

  // State the host has already published before the viewer arrives.
  host.emit("host:active-file", { sessionId, path: "app.js" });
  host.emit("host:tree", { sessionId, tree: TREE });
  host.emit("host:buffer", { sessionId, path: "app.js", content: "console.log('before join')", version: 1 });
  await sleep(500);

  const viewer = await connect(viewerUrl);
  const snapshotPromise = waitFor(viewer, "sync:snapshot");
  const hostSawJoin = waitFor(host, "session:state", (state) => state.viewerCount === 1);
  const joined = await emitAck(viewer, "session:join", { code });
  assert(joined.ok === true, `${label}: a viewer on the OTHER replica joined by code`);
  assert(joined.session.id === sessionId, `${label}: the viewer got the host's session`);
  const snapshot = await snapshotPromise;
  assert(
    snapshot.buffer?.content === "console.log('before join')" && snapshot.activePath === "app.js" && snapshot.tree !== null,
    `${label}: the cross-replica snapshot carries the host's buffer, active file and tree`,
  );
  await hostSawJoin;
  pass(`${label}: the host (on the first replica) saw the viewer count become 1`);

  const bufferEvent = waitFor(viewer, "editor:buffer", (event) => event.buffer.content === "console.log('after join')");
  const cursorEvent = waitFor(viewer, "editor:cursor");
  host.emit("host:buffer", { sessionId, path: "app.js", content: "console.log('after join')", version: 2 });
  host.emit("host:cursor", { sessionId, path: "app.js", position: { line: 1, column: 5 } });
  const live = await bufferEvent;
  assert(live.seq > snapshot.seq, `${label}: a live edit crossed replicas and its seq follows the snapshot's`);
  const cursor = await cursorEvent;
  assert(cursor.cursor.position.line === 1 && cursor.cursor.position.column === 5, `${label}: the caret crossed replicas`);

  const treeEvent = waitFor(viewer, "editor:tree");
  host.emit("host:tree", {
    sessionId,
    tree: { ...TREE, children: [...TREE.children, { name: "b.js", path: "b.js", kind: "file" }] },
  });
  const tree = await treeEvent;
  assert(tree.tree.children?.length === 2, `${label}: a file-tree change crossed replicas`);

  const resync = await emitAck(viewer, "viewer:resync", { sessionId });
  assert(
    resync.ok === true && resync.snapshot.buffer?.content === "console.log('after join')",
    `${label}: viewer:resync from the other replica returns the current snapshot`,
  );

  const hostSawLeave = waitFor(host, "session:state", (state) => state.viewerCount === 0);
  viewer.emit("session:leave", { sessionId });
  await hostSawLeave;
  pass(`${label}: the viewer leaving updated the host's viewer count back to 0`);

  // A second viewer, to prove session:ended reaches the other replica when the host goes away.
  const viewer2 = await connect(viewerUrl);
  await emitAck(viewer2, "session:join", { code });
  const endedEvent = waitFor(viewer2, "session:ended", (event) => event.sessionId === sessionId);
  host.disconnect();
  await endedEvent;
  pass(`${label}: the host disconnecting delivered session:ended to a viewer on the other replica`);

  const afterEnd = await emitAck(viewer, "session:join", { code });
  assert(afterEnd.ok === false, `${label}: the ended room can no longer be joined from either replica`);
  viewer.disconnect();
  viewer2.disconnect();
}

async function socketsMode() {
  console.log("== sockets: routing across two streaming replicas ==");
  const a = await health(STREAMING_A_URL);
  const b = await health(STREAMING_B_URL);
  assert(a.status === 200 && b.status === 200, "both streaming replicas answer /health");
  assert(a.body.clustered === true && b.body.clustered === true, "both replicas run with the Redis adapter");
  assert(a.body.node !== b.body.node, `the replicas have distinct node ids (${a.body.node}, ${b.body.node})`);
  assert(a.body.nodes === 2 && b.body.nodes === 2, "each replica sees 2 nodes attached to the adapter");

  await exerciseDirection("host on replica 1, viewer on replica 2", STREAMING_A_URL, STREAMING_B_URL);
  await exerciseDirection("host on replica 2, viewer on replica 1", STREAMING_B_URL, STREAMING_A_URL);

  console.log("-- unknown code");
  const stray = await connect(STREAMING_B_URL);
  const missing = await emitAck(stray, "session:join", { code: "ZZZZZZ" });
  assert(missing.ok === false, "joining an unknown code is refused (after asking every replica)");
  stray.disconnect();

  if (STREAMING_LB_URL) {
    console.log("-- through the load balancer");
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      const response = await health(STREAMING_LB_URL, STREAMING_LB_HOST);
      assert(response.status === 200, `LB request ${i + 1} reached a healthy replica`);
      seen.add(response.body.node);
    }
    assert(seen.size === 2, `the load balancer spreads new requests over both replicas (${[...seen].join(", ")})`);

    const host = await connect(STREAMING_LB_URL, { hostHeader: STREAMING_LB_HOST });
    const created = await emitAck(host, "session:create", { topic: "p8-lb" });
    assert(created.ok === true, "a host connected through the LB created a session");
    let joinedFromEverywhere = 0;
    for (let i = 0; i < 6; i += 1) {
      const viewer = await connect(STREAMING_LB_URL, { hostHeader: STREAMING_LB_HOST });
      const joined = await emitAck(viewer, "session:join", { code: created.session.code });
      if (joined.ok === true) {
        joinedFromEverywhere += 1;
      }
      viewer.disconnect();
    }
    assert(joinedFromEverywhere === 6, "6 of 6 viewers connected through the LB joined, whichever replica they landed on");
    host.disconnect();
  }
}

/** Runs a shell command and resolves when it exits 0. */
function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`"${command}" exited with ${code}`))));
  });
}

async function restartMode() {
  console.log("== restart: rolling restart of streaming replica 1 ==");
  const restartCmd = process.env.RESTART_CMD;
  if (!restartCmd) {
    throw new Error("RESTART_CMD is required");
  }
  const target = STREAMING_LB_URL || STREAMING_B_URL;
  const targetHost = STREAMING_LB_URL ? STREAMING_LB_HOST : undefined;

  // 3 hosts + viewers pinned on replica 2 (untouched), 3 hosts on replica 1 (restarted).
  const survivors = [];
  for (let i = 0; i < 3; i += 1) {
    const host = await connect(STREAMING_B_URL);
    const created = await emitAck(host, "session:create", { topic: `p8-survivor-${i}` });
    const viewer = await connect(STREAMING_B_URL);
    await emitAck(viewer, "session:join", { code: created.session.code });
    survivors.push({ host, viewer, sessionId: created.session.id });
  }
  const crossViewers = [];
  const victims = [];
  for (let i = 0; i < 3; i += 1) {
    const host = await connect(STREAMING_A_URL, { reconnection: true });
    const created = await emitAck(host, "session:create", { topic: `p8-victim-${i}` });
    const viewer = await connect(STREAMING_B_URL);
    await emitAck(viewer, "session:join", { code: created.session.code });
    crossViewers.push({ viewer, sessionId: created.session.id });
    victims.push(host);
  }
  pass("6 hosts and 6 viewers are connected before the restart");

  let survivorDrops = 0;
  for (const { host, viewer } of survivors) {
    host.on("disconnect", () => { survivorDrops += 1; });
    viewer.on("disconnect", () => { survivorDrops += 1; });
  }
  const endedSeen = crossViewers.map(({ viewer, sessionId }) =>
    waitFor(viewer, "session:ended", (event) => event.sessionId === sessionId, 30000),
  );
  const victimReconnects = victims.map(
    (socket) => new Promise((resolve) => socket.once("connect", resolve)),
  );

  // Keep opening new WebSocket connections while replica 1 restarts: none may be refused.
  let probeFailures = 0;
  let probes = 0;
  let probing = true;
  const prober = (async () => {
    while (probing) {
      probes += 1;
      try {
        const probe = await connect(target, targetHost ? { hostHeader: targetHost } : {});
        probe.disconnect();
      } catch {
        probeFailures += 1;
      }
      await sleep(100);
    }
  })();

  await run(restartCmd);
  pass("replica 1 was restarted");

  await Promise.all(endedSeen);
  pass("viewers on replica 2 were told session:ended for the rooms hosted on the restarted replica");
  await Promise.race([
    Promise.all(victimReconnects),
    sleep(20000).then(() => { throw new Error("hosts did not reconnect after the restart"); }),
  ]);
  pass("hosts that were on the restarted replica reconnected automatically");

  probing = false;
  await prober;
  assert(probeFailures === 0, `no new WebSocket connection was refused during the restart (${probes} attempts through ${STREAMING_LB_URL ? "the load balancer" : "replica 2"})`);
  assert(survivorDrops === 0, "no connection on the untouched replica was dropped");
  for (const { host, viewer, sessionId } of survivors) {
    assert(host.connected && viewer.connected, "survivor sockets are still connected");
    const resync = await emitAck(viewer, "viewer:resync", { sessionId });
    assert(resync.ok === true, "a surviving room still resyncs");
  }

  const fresh = await connect(STREAMING_A_URL);
  const created = await emitAck(fresh, "session:create", { topic: "p8-after-restart" });
  assert(created.ok === true, "the restarted replica accepts new sessions");
  const fromOther = await connect(STREAMING_B_URL);
  const joined = await emitAck(fromOther, "session:join", { code: created.session.code });
  assert(joined.ok === true, "and the other replica can join them");
}

async function postgresMode() {
  console.log("== postgres: schema, accounts, history, audit, durability ==");
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  const orchestrator = await import(pathToFileURL(path.join(repoRoot, "packages/orchestrator/dist/index.js")).href);
  const { PostgresDatabase, loadPostgresOptions, hashPassword } = orchestrator;
  const logger = { info() {}, warn() {}, error(message, fields) { console.error(message, fields); } };

  const optionsA = loadPostgresOptions({ DATABASE_URL: url, REPLICA_ID: "check-a" }, logger);
  const optionsB = loadPostgresOptions({ DATABASE_URL: url, REPLICA_ID: "check-b" }, logger);
  const dbA = await PostgresDatabase.connect(optionsA);
  const dbB = await PostgresDatabase.connect(optionsB);

  // Two replicas booting together.
  const [first, second] = await Promise.all([dbA.migrate(), dbB.migrate()]);
  assert(first.length + second.length <= 1, "concurrent migrate() from two replicas applies the schema at most once");
  assert((await dbA.migrate()).length === 0, "migrate() is idempotent: a second run applies nothing");

  const stamp = Date.now().toString(36);
  const users = [
    { id: `p8_alice_${stamp}`, username: `p8alice${stamp}`, passwordHash: await hashPassword("alice-pw") },
    { id: `p8_bob_${stamp}`, username: `p8bob${stamp}`, passwordHash: await hashPassword("bob-pw") },
  ];
  await Promise.all([dbA.syncAccounts(users), dbB.syncAccounts(users)]);
  const alice = await dbB.getAccount(users[0].id);
  assert(alice !== undefined && alice.passwordHash === users[0].passwordHash, "accounts synced from two replicas at once are readable from either");
  assert((await dbA.findAccountByUsername(users[1].username.toUpperCase()))?.id === users[1].id, "usernames are looked up case-insensitively");
  assert((await dbA.listAccounts()).every((account) => !("passwordHash" in account)), "listAccounts never returns password hashes");
  assert(await dbA.setAccountDisabled(users[1].id, true), "an account can be disabled");
  await dbB.syncAccounts(users);
  assert((await dbA.getAccount(users[1].id))?.disabled === true, "syncing configured users does not re-enable a disabled account");
  await dbA.recordLogin(users[0].id, Date.now());
  assert((await dbA.getAccount(users[0].id))?.lastLoginAt !== null, "sign-ins are stamped");

  const startedAt = Date.now() - 60_000;
  const record = {
    sessionId: `s_p8_${stamp}`,
    ownerId: users[0].id,
    containerId: `c_${stamp}`,
    image: "live/sandbox-base:latest",
    hostAgentPort: 49152,
    status: "running",
    createdAt: startedAt,
    updatedAt: startedAt + 5_000,
  };
  await Promise.all([dbA.recordSessionStarted(record), dbB.recordSessionStarted(record)]);
  let entry = await dbA.getSessionHistory(record.sessionId);
  assert(entry !== undefined && entry.endedAt === null && entry.durationMs === null, "a started session has no end and no duration");
  assert(entry.ownerId === users[0].id && entry.startedAt === startedAt, "owner and start time are recorded exactly");

  await Promise.all([
    dbA.recordSessionEnded(record, "idle", startedAt + 60_000),
    dbB.recordSessionEnded(record, "api", startedAt + 61_000),
  ]);
  entry = await dbA.getSessionHistory(record.sessionId);
  assert(entry.endedAt !== null && entry.endReason !== null, "a session that two replicas ended concurrently has one consistent end");
  assert(entry.durationMs === entry.endedAt - entry.startedAt && entry.durationMs >= 60_000, "duration equals end minus start");
  const endedAtBefore = entry.endedAt;
  await dbA.recordSessionStarted({ ...record, status: "running" });
  assert((await dbA.getSessionHistory(record.sessionId)).endedAt === endedAtBefore, "recording a start again never re-opens an ended session");

  const owned = await dbB.listSessionHistory({ ownerId: users[0].id });
  assert(owned.length === 1 && owned[0].sessionId === record.sessionId, "history is filterable by owner");
  const stats = await dbB.getOwnerStats(users[0].id);
  assert(stats.totalSessions === 1 && stats.activeSessions === 0 && stats.totalDurationMs >= 60_000, "owner stats count sessions and total duration");

  await dbA.recordAudit({ event: "p8.check", actorId: users[0].id, sessionId: record.sessionId, detail: { n: 1 } });
  const audit = await dbB.listAudit({ sessionId: record.sessionId, event: "p8.check" });
  assert(audit.length === 1 && audit[0].detail.n === 1 && audit[0].replicaId === "check-a", "audit entries are shared across replicas and tagged with their replica");

  if (process.env.RESTART_DB_CMD) {
    await dbA.close();
    await dbB.close();
    await run(process.env.RESTART_DB_CMD);
    pass("Postgres was restarted");
    const reopened = await PostgresDatabase.connect(optionsA);
    const kept = await reopened.getSessionHistory(record.sessionId);
    assert(kept !== undefined && kept.endedAt === endedAtBefore, "session history survived a Postgres restart");
    assert((await reopened.getAccount(users[0].id)) !== undefined, "accounts survived a Postgres restart");
    assert((await reopened.listAudit({ sessionId: record.sessionId })).length >= 1, "audit entries survived a Postgres restart");
    await reopened.close();
  } else {
    await dbA.close();
    await dbB.close();
  }
}

async function storeMode() {
  console.log("== store: two orchestrator session stores sharing Redis and Postgres ==");
  const url = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!url || !redisUrl) {
    throw new Error("DATABASE_URL and REDIS_URL are required");
  }
  const prefix = process.env.REDIS_KEY_PREFIX ?? "live-p8-check:";
  const orchestrator = await import(pathToFileURL(path.join(repoRoot, "packages/orchestrator/dist/index.js")).href);
  const { PostgresDatabase, HistoryRecordingSessionStore, RedisSessionStore, createRedisClient, loadPostgresOptions } = orchestrator;
  const logger = { info() {}, warn(message, fields) { console.error("warn:", message, fields); }, error(message, fields) { console.error("error:", message, fields); } };

  async function replica(name) {
    const redis = createRedisClient(redisUrl, logger);
    await redis.connect();
    const db = await PostgresDatabase.connect(loadPostgresOptions({ DATABASE_URL: url, REPLICA_ID: name }, logger));
    await db.migrate();
    const inner = new RedisSessionStore(redis, { keyPrefix: prefix, logger });
    return { name, redis, db, store: new HistoryRecordingSessionStore(inner, db, logger, () => Date.now()) };
  }
  const a = await replica("store-a");
  const b = await replica("store-b");

  const stamp = Date.now().toString(36);
  const ids = Array.from({ length: 8 }, (_, i) => `s_store_${stamp}_${i}`);
  const now = Date.now();
  const make = (sessionId, ownerId) => ({
    sessionId, ownerId, containerId: `c_${sessionId}`, image: "live/sandbox-base:latest",
    hostAgentPort: 40000, status: "running", createdAt: now, updatedAt: now,
  });

  await Promise.all(ids.map((id, i) => (i % 2 === 0 ? a : b).store.set(id, make(id, i % 2 === 0 ? "u_a" : "u_b"))));
  const listedByA = (await a.store.list()).filter((r) => ids.includes(r.sessionId));
  const listedByB = (await b.store.list()).filter((r) => ids.includes(r.sessionId));
  assert(listedByA.length === 8 && listedByB.length === 8, "8 sessions created concurrently through two replicas are all visible to both");
  assert((await b.store.get(ids[0]))?.ownerId === "u_a" && (await a.store.get(ids[1]))?.ownerId === "u_b", "each replica reads the other's records with the right owner");

  await a.store.touch(ids[1], now + 9_000);
  assert((await b.store.get(ids[1]))?.updatedAt === now + 9_000, "a heartbeat recorded through one replica is seen by the other");

  const open = await a.db.listSessionHistory({ active: true });
  assert(ids.every((id) => open.some((entry) => entry.sessionId === id)), "every create was written to the durable history");

  // Both replicas try to tear every session down at once (reaper on one, DELETE on the other).
  await Promise.all(ids.flatMap((id) => [a.store.delete(id), b.store.delete(id)]));
  assert((await a.store.list()).filter((r) => ids.includes(r.sessionId)).length === 0, "concurrent deletes from two replicas leave no record in Redis");
  const finished = await Promise.all(ids.map((id) => a.db.getSessionHistory(id)));
  assert(finished.every((entry) => entry && entry.endedAt !== null && entry.durationMs !== null), "every session has exactly one ended history row");
  assert(finished[0].ownerId === "u_a" && finished[1].ownerId === "u_b", "history keeps the owner after Redis has forgotten the session");
  assert(finished[1].lastActivityAt === now + 9_000, "history keeps the last heartbeat time");
  const endedAudit = await a.db.listAudit({ sessionId: ids[0], event: "session.ended" });
  assert(endedAudit.length >= 1 && endedAudit[0].actorId === "u_a", "an audit event names the owner");

  for (const r of [a, b]) {
    await r.redis.quit();
    await r.db.close();
  }
}

const mode = process.argv[2];
try {
  if (mode === "sockets") {
    await socketsMode();
  } else if (mode === "restart") {
    await restartMode();
  } else if (mode === "postgres") {
    await postgresMode();
  } else if (mode === "store") {
    await storeMode();
  } else {
    throw new Error("usage: clusterCheck.mjs sockets|restart|postgres|store");
  }
  for (const socket of openSockets) {
    socket.disconnect();
  }
  process.exit(0);
} catch (error) {
  console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
  for (const socket of openSockets) {
    socket.disconnect();
  }
  process.exit(1);
}