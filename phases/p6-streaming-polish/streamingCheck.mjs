#!/usr/bin/env node
/**
 * Phase 6 protocol check. Runs against a live streaming server (see verify.sh)
 * and proves, with real Socket.IO clients:
 *
 *   A. the rate limiter's guarantees, deterministically, on a fake clock
 *   B. a viewer that refreshes mid-session gets the host's buffer, file tree,
 *      active file and caret back in under 2 seconds
 *   C. viewers cannot write host state; oversize / malformed / flooding input
 *      is rejected without corrupting the room
 *   D. caret updates reach viewers at no more than 10 per second, and the
 *      final position is never lost
 *   E. 50 simultaneous viewers join, receive live updates, leave, and the
 *      server stays healthy
 *
 * Environment: STREAMING_URL (default http://127.0.0.1:4012)
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STREAMING_URL = process.env.STREAMING_URL ?? "http://127.0.0.1:4012";

// socket.io-client is a dependency of @live/web, so resolve it from there.
const requireFromWeb = createRequire(path.join(repoRoot, "packages/web/package.json"));
const { io } = requireFromWeb("socket.io-client");

const { TrailingThrottle, TokenBucket, minIntervalMsForHz } = await import(
  pathToFileURL(path.join(repoRoot, "packages/streaming/dist/rateLimiter.js")).href
);

/* ---------------------------------------------------------------- helpers */

const openSockets = new Set();

function pass(message) {
  console.log(`  PASS: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  pass(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(STREAMING_URL, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    openSockets.add(socket);
    const timer = setTimeout(() => reject(new Error("timed out connecting to the streaming server")), 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not connect to ${STREAMING_URL}: ${error.message}`));
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no acknowledgement for "${event}" within ${timeoutMs}ms`)), timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/** Resolves with the first `event` payload accepted by `predicate`. Attach BEFORE triggering the event. */
function waitFor(socket, event, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      socket.off(event, onEvent);
    }
    function onEvent(payload) {
      if (!predicate(payload)) {
        return;
      }
      cleanup();
      resolve(payload);
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}

/** Records every `event` payload (with its arrival time) until stop() is called. */
function collect(socket, event) {
  const items = [];
  const listener = (payload) => items.push({ payload, receivedAt: performance.now() });
  socket.on(event, listener);
  return { items, stop: () => socket.off(event, listener) };
}

/** Host-side barrier: an acknowledged call returns only after every earlier event from this socket was handled. */
async function barrier(host, sessionId) {
  const ack = await emitAck(host, "session:update", { sessionId, patch: { state: "live" } });
  if (!ack.ok) {
    throw new Error(`barrier failed: ${ack.error}`);
  }
}

/** Largest number of events inside any closed window of `windowMs`, given ascending timestamps. */
function maxInWindow(timestamps, windowMs) {
  let max = 0;
  for (let i = 0; i < timestamps.length; i += 1) {
    let count = 0;
    for (let j = i; j < timestamps.length; j += 1) {
      if (timestamps[j] - timestamps[i] <= windowMs) {
        count += 1;
      } else {
        break;
      }
    }
    max = Math.max(max, count);
  }
  return max;
}

function makeFakeTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    timers: {
      setTimer: (callback, delayMs) => {
        const id = nextId;
        nextId += 1;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    advance(toMs) {
      for (;;) {
        let next;
        for (const [id, timer] of timers) {
          if (timer.at <= toMs && (next === undefined || timer.at < next.timer.at)) {
            next = { id, timer };
          }
        }
        if (next === undefined) {
          break;
        }
        timers.delete(next.id);
        now = Math.max(now, next.timer.at);
        next.timer.callback();
      }
      now = toMs;
    },
  };
}

const TREE = {
  name: "workspace",
  path: "",
  kind: "directory",
  children: [
    { name: "README.md", path: "README.md", kind: "file" },
    {
      name: "src",
      path: "src",
      kind: "directory",
      children: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
    },
  ],
};

async function createHostedSession(topic) {
  const host = await connect();
  const ack = await emitAck(host, "session:create", { topic });
  if (!ack.ok) {
    throw new Error(`session:create failed: ${ack.error}`);
  }
  return { host, sessionId: ack.session.id, code: ack.session.code };
}

/** Connects a viewer, joins by code, and resolves once the join snapshot has arrived. */
async function joinViewer(code) {
  const socket = await connect();
  const snapshotPromise = waitFor(socket, "sync:snapshot", () => true, 4000);
  const ack = await emitAck(socket, "session:join", { code });
  if (!ack.ok) {
    throw new Error(`session:join failed: ${ack.error}`);
  }
  const snapshot = await snapshotPromise;
  return { socket, session: ack.session, snapshot };
}

/* ------------------------------------------------------------------- A */

function checkRateLimiter() {
  console.log("== A. rate limiter (fake clock, deterministic) ==");

  assert(minIntervalMsForHz(10) === 101, "10Hz ceiling maps to a 101ms minimum spacing (so no closed 1s window holds 11)");

  const time = makeFakeTime();
  const emittedAt = [];
  let triggers = 0;
  const emittedAfterTriggers = [];
  const throttle = new TrailingThrottle(
    minIntervalMsForHz(10),
    () => {
      emittedAt.push(time.now());
      emittedAfterTriggers.push(triggers);
    },
    { now: time.now, timers: time.timers },
  );
  for (let ms = 0; ms < 5000; ms += 1) {
    time.advance(ms);
    triggers += 1;
    throttle.trigger();
  }
  time.advance(6000);

  assert(triggers === 5000, "driver fired 5000 triggers (1000 per second for 5s)");
  assert(emittedAt.length >= 45 && emittedAt.length <= 52, `5000 triggers coalesced into ${emittedAt.length} emits (expected ~50)`);
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < emittedAt.length; i += 1) {
    minGap = Math.min(minGap, emittedAt[i] - emittedAt[i - 1]);
  }
  assert(minGap >= 101, `consecutive emits are at least 101ms apart (smallest gap ${minGap}ms)`);
  assert(maxInWindow(emittedAt, 1000) <= 10, `no closed 1s window holds more than 10 emits (max ${maxInWindow(emittedAt, 1000)})`);
  assert(
    emittedAfterTriggers[emittedAfterTriggers.length - 1] === 5000,
    "the trailing emit fired after the final trigger: the last value is never lost",
  );

  const bucketTime = makeFakeTime();
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: bucketTime.now });
  const first = [bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()];
  assert(first.join() === "true,true,true,false", "token bucket allows its burst of 3 and refuses the 4th");
  bucketTime.advance(1000);
  assert(bucket.tryConsume() === true && bucket.tryConsume() === false, "token bucket refills at 1 token per second");
  bucketTime.advance(60_000);
  const afterIdle = [bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()];
  assert(afterIdle.join() === "true,true,true,false", "token bucket never refills past its capacity");
}

/* ------------------------------------------------------------------- B */

async function checkResync() {
  console.log("== B. viewer refresh mid-session resyncs buffer + file tree (<2s) ==");
  const { host, sessionId, code } = await createHostedSession("p6 resync");
  const hostEditorEvents = ["editor:active-file", "editor:buffer", "editor:tree", "editor:cursor"].map((event) =>
    collect(host, event),
  );

  const viewer1 = await joinViewer(code);
  assert(
    viewer1.snapshot.seq === 0 && viewer1.snapshot.buffer === null && viewer1.snapshot.tree === null,
    "a viewer joining a fresh session receives an empty snapshot right after the join ack",
  );

  const live = {
    activeFile: waitFor(viewer1.socket, "editor:active-file", (e) => e.path === "src/index.ts"),
    buffer: waitFor(viewer1.socket, "editor:buffer", (e) => e.buffer.content === "const a = 1;\n"),
    tree: waitFor(viewer1.socket, "editor:tree"),
    cursor: waitFor(viewer1.socket, "editor:cursor"),
  };
  const liveEvents = ["editor:active-file", "editor:buffer", "editor:tree", "editor:cursor"].map((event) =>
    collect(viewer1.socket, event),
  );

  host.emit("host:active-file", { sessionId, path: "src/index.ts" });
  host.emit("host:buffer", { sessionId, path: "src/index.ts", content: "const a = 1;\n", version: 1 });
  host.emit("host:tree", { sessionId, tree: TREE });
  host.emit("host:cursor", { sessionId, path: "src/index.ts", position: { line: 1, column: 5 } });
  await Promise.all(Object.values(live));
  pass("a connected viewer receives the host's active file, buffer, file tree and caret live");

  const seqs = liveEvents
    .flatMap((collector) => collector.items)
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .map((item) => item.payload.seq);
  assert(
    seqs.length >= 4 && seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]),
    `broadcast sequence numbers strictly increase in arrival order (${seqs.join(", ")})`,
  );

  await barrier(host, sessionId);
  viewer1.socket.disconnect();
  await sleep(150);

  // The refresh: a brand-new socket, a brand-new page load.
  const startedAt = performance.now();
  const viewer2 = await joinViewer(code);
  const elapsedMs = performance.now() - startedAt;
  assert(elapsedMs < 2000, `refresh -> connected -> joined -> full snapshot in ${elapsedMs.toFixed(0)}ms (limit 2000ms)`);
  assert(viewer2.session.viewerCount === 1, "the refreshed viewer replaces the old one: viewerCount is 1, not 2");

  const snap = viewer2.snapshot;
  assert(snap.activePath === "src/index.ts", "snapshot restores the host's active file");
  assert(
    snap.buffer?.path === "src/index.ts" && snap.buffer.content === "const a = 1;\n",
    "snapshot restores the host's latest buffer",
  );
  assert(
    snap.tree?.children?.some((child) => child.name === "src" && child.children?.[0]?.path === "src/index.ts") === true,
    "snapshot restores the host's file tree",
  );
  assert(snap.cursor?.position.line === 1 && snap.cursor.position.column === 5, "snapshot restores the host's caret");

  const resynced = await emitAck(viewer2.socket, "viewer:resync", { sessionId });
  assert(resynced.ok === true && resynced.snapshot.buffer?.content === "const a = 1;\n", "viewer:resync returns the current snapshot on demand");

  const nextBuffer = waitFor(viewer2.socket, "editor:buffer", (e) => e.buffer.content === "const a = 2;\n");
  host.emit("host:buffer", { sessionId, path: "src/index.ts", content: "const a = 2;\n", version: 2 });
  const update = await nextBuffer;
  assert(update.seq > snap.seq, `live updates after a snapshot carry a newer seq (${update.seq} > ${snap.seq})`);

  await barrier(host, sessionId);
  assert(
    hostEditorEvents.every((collector) => collector.items.length === 0),
    "the host never receives echoes of its own editor events",
  );

  return { host, sessionId, code, viewer: viewer2 };
}

/* ------------------------------------------------------------------- C */

async function checkGuards({ host, sessionId, viewer }) {
  console.log("== C. authorization, validation and flood protection ==");

  const denied = waitFor(viewer.socket, "session:error", (e) => /host/i.test(e.message));
  viewer.socket.emit("host:buffer", { sessionId, path: "src/index.ts", content: "HIJACKED", version: 99 });
  await denied;
  pass("a viewer sending host:buffer is refused with an error");

  const oversize = waitFor(host, "session:error", (e) => /larger than/.test(e.message));
  host.emit("host:buffer", { sessionId, path: "src/index.ts", content: "x".repeat(200_001), version: 3 });
  await oversize;
  pass("a buffer over 200,000 characters is refused");

  const wrongFile = waitFor(host, "session:error", (e) => /active file/.test(e.message));
  host.emit("host:buffer", { sessionId, path: "not-the-active-file.ts", content: "nope", version: 4 });
  await wrongFile;
  pass("a buffer for a file that is not the active file is refused");

  await barrier(host, sessionId);
  const unchanged = await emitAck(viewer.socket, "viewer:resync", { sessionId });
  assert(
    unchanged.ok === true && unchanged.snapshot.buffer?.content === "const a = 2;\n",
    "none of the rejected events changed the room's buffer",
  );

  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () => emitAck(viewer.socket, "viewer:resync", { sessionId })),
  );
  const refused = outcomes.filter((outcome) => outcome.ok === false);
  assert(
    refused.length >= 3 && refused.every((outcome) => /rate limit/i.test(outcome.error)),
    `a viewer hammering viewer:resync is rate limited (${refused.length} of 8 refused)`,
  );

  await sleep(1100); // let the host's error-reply allowance refill
  const floodError = waitFor(host, "session:error", (e) => /rate limit/i.test(e.message));
  const tinyTree = { name: "workspace", path: "", kind: "directory", children: [] };
  for (let i = 0; i < 200; i += 1) {
    host.emit("host:tree", { sessionId, tree: tinyTree });
  }
  await floodError;
  pass("a burst of 200 host:tree events trips the ingest limiter");

  await sleep(2300); // the host's ingest bucket refills at 20 per second
  const recovered = waitFor(viewer.socket, "editor:buffer", (e) => e.buffer.content === "const a = 3;\n");
  host.emit("host:buffer", { sessionId, path: "src/index.ts", content: "const a = 3;\n", version: 5 });
  await recovered;
  pass("after the burst, normal host updates flow again");

  const switched = waitFor(viewer.socket, "editor:active-file", (e) => e.path === "README.md");
  host.emit("host:active-file", { sessionId, path: "README.md" });
  await switched;
  await barrier(host, sessionId);
  const afterSwitch = await emitAck(viewer.socket, "viewer:resync", { sessionId }).catch(() => undefined);
  if (afterSwitch?.ok === false) {
    await sleep(1100);
  }
  const switchedSnapshot = afterSwitch?.ok === true ? afterSwitch : await emitAck(viewer.socket, "viewer:resync", { sessionId });
  assert(
    switchedSnapshot.ok === true &&
      switchedSnapshot.snapshot.activePath === "README.md" &&
      switchedSnapshot.snapshot.buffer === null &&
      switchedSnapshot.snapshot.cursor === null,
    "switching files drops the previous file's buffer and caret instead of serving them stale",
  );
}

/* ------------------------------------------------------------------- D */

async function checkCursorRate({ host, sessionId, viewer }) {
  console.log("== D. caret stream is limited to 10Hz and keeps its final position ==");
  await sleep(400);

  const hostErrors = collect(host, "session:error");
  const cursorEvents = collect(viewer.socket, "editor:cursor");

  let sent = 0;
  let lastLine = 1;
  const flood = setInterval(() => {
    lastLine = (sent % 9999) + 1;
    host.emit("host:cursor", { sessionId, path: "README.md", position: { line: lastLine, column: 1 } });
    sent += 1;
  }, 2);
  await sleep(5000);
  clearInterval(flood);
  await barrier(host, sessionId);
  await sleep(500); // the trailing broadcast
  cursorEvents.stop();
  hostErrors.stop();

  assert(sent >= 500, `the host sent ${sent} caret updates in 5s (${Math.round(sent / 5)}/s, far above 10/s)`);
  const received = cursorEvents.items;
  assert(received.length >= 35 && received.length <= 52, `viewer received ${received.length} caret updates (expected ~50 for a 5s flood)`);

  const emittedAt = received.map((item) => item.payload.cursor.emittedAt);
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < emittedAt.length; i += 1) {
    minGap = Math.min(minGap, emittedAt[i] - emittedAt[i - 1]);
  }
  assert(minGap >= 101 - 0.001, `server broadcasts are at least 101ms apart (smallest gap ${minGap.toFixed(2)}ms)`);
  const peak = maxInWindow(emittedAt, 1000);
  assert(peak <= 10, `no closed 1s window holds more than 10 caret broadcasts (peak ${peak})`);

  const durationSeconds = (received[received.length - 1].receivedAt - received[0].receivedAt) / 1000;
  const averageHz = (received.length - 1) / durationSeconds;
  assert(averageHz <= 10, `average rate seen by the viewer is ${averageHz.toFixed(2)}Hz (limit 10Hz)`);

  assert(
    received[received.length - 1].payload.cursor.position.line === lastLine,
    `the final caret position (line ${lastLine}) was delivered despite the flood`,
  );
  assert(hostErrors.items.length === 0, "flooding caret updates is coalesced, not punished with errors");
}

/* ------------------------------------------------------------------- E */

async function checkFiftyViewers() {
  console.log("== E. 50 simultaneous viewers ==");
  const { host, sessionId, code } = await createHostedSession("p6 fifty");
  const bigBuffer = "const line = 0; // padding padding padding\n".repeat(3500); // ~150KB
  host.emit("host:active-file", { sessionId, path: "src/index.ts" });
  host.emit("host:buffer", { sessionId, path: "src/index.ts", content: bigBuffer, version: 1 });
  host.emit("host:tree", { sessionId, tree: TREE });
  host.emit("host:cursor", { sessionId, path: "src/index.ts", position: { line: 7, column: 3 } });
  await barrier(host, sessionId);

  const hostStates = collect(host, "session:state");
  const startedAt = performance.now();
  const viewers = await Promise.all(Array.from({ length: 50 }, () => joinViewer(code)));
  const elapsedMs = performance.now() - startedAt;
  assert(viewers.length === 50, "all 50 viewers connected and joined");
  assert(elapsedMs < 2000, `50 viewers connected, joined and received a ~150KB snapshot each in ${elapsedMs.toFixed(0)}ms (limit 2000ms)`);
  assert(
    viewers.every(
      ({ snapshot }) =>
        snapshot.buffer?.content === bigBuffer && snapshot.tree !== null && snapshot.cursor?.position.line === 7,
    ),
    "every one of the 50 snapshots has the full buffer, file tree and caret",
  );

  await waitFor(host, "session:state", (s) => s.viewerCount === 50, 3000).catch(() => undefined);
  assert(
    hostStates.items.some((item) => item.payload.viewerCount === 50),
    "the host's view of the room reached viewerCount 50",
  );
  hostStates.stop();

  const disconnects = viewers.map(({ socket }) => {
    const record = { dropped: false };
    socket.on("disconnect", () => {
      record.dropped = true;
    });
    return record;
  });
  const perViewerBuffer = viewers.map(({ socket }) => waitFor(socket, "editor:buffer", (e) => e.buffer.content === "hello 50", 4000));
  const perViewerCursor = viewers.map(({ socket }) => collect(socket, "editor:cursor"));

  host.emit("host:buffer", { sessionId, path: "src/index.ts", content: "hello 50", version: 2 });
  let sent = 0;
  let lastLine = 1;
  const flood = setInterval(() => {
    lastLine = (sent % 9999) + 1;
    host.emit("host:cursor", { sessionId, path: "src/index.ts", position: { line: lastLine, column: 2 } });
    sent += 1;
  }, 2);
  await sleep(1500);
  clearInterval(flood);
  await barrier(host, sessionId);
  await sleep(500);
  perViewerCursor.forEach((collector) => collector.stop());

  await Promise.all(perViewerBuffer);
  pass("all 50 viewers received the host's live buffer update");
  assert(
    perViewerCursor.every((collector) => {
      const items = collector.items;
      return items.length > 0 && items[items.length - 1].payload.cursor.position.line === lastLine;
    }),
    "all 50 viewers ended on the host's final caret position",
  );
  const worstPeak = Math.max(
    ...perViewerCursor.map((collector) => maxInWindow(collector.items.map((i) => i.payload.cursor.emittedAt), 1000)),
  );
  assert(worstPeak <= 10, `no viewer saw more than 10 caret updates in a 1s window (worst ${worstPeak})`);
  assert(disconnects.every((record) => !record.dropped), "no viewer was disconnected under load");

  const countAfterLeaving = waitFor(host, "session:state", (s) => s.viewerCount === 25, 3000);
  for (const { socket } of viewers.slice(25)) {
    socket.disconnect();
  }
  await countAfterLeaving;
  pass("25 viewers leaving brings the host's viewerCount to 25");

  const health = await fetch(`${STREAMING_URL}/health`).then((response) => response.json());
  assert(health.ok === true, "the streaming server still answers /health");

  const ended = viewers.slice(0, 25).map(({ socket }) => waitFor(socket, "session:ended", () => true, 3000));
  host.disconnect();
  await Promise.all(ended);
  pass("when the host leaves, all remaining viewers are told the session ended");

  const lateJoin = await emitAck(await connect(), "session:join", { code });
  assert(lateJoin.ok === false, "an ended session cannot be rejoined");
  const lateResync = await emitAck(viewers[0].socket, "viewer:resync", { sessionId });
  assert(lateResync.ok === false, "an ended session cannot be resynced");
}

/* ------------------------------------------------------------------ main */

async function main() {
  checkRateLimiter();
  console.log();
  const room = await checkResync();
  console.log();
  await checkGuards(room);
  console.log();
  await checkCursorRate(room);
  console.log();
  room.host.disconnect();
  await checkFiftyViewers();
  console.log();
  console.log("All Phase 6 streaming checks passed.");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  for (const socket of openSockets) {
    socket.disconnect();
  }
}
process.exit(exitCode);