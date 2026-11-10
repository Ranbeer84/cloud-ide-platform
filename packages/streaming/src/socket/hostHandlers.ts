import type { Server, Socket } from "socket.io";
import type {
  ClientToServerEvents,
  CursorPosition,
  EditorBufferState,
  EditorCursorState,
  FsTreeNode,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
  SyncSnapshot,
} from "@live/shared-types";
import {
  BUFFER_MAX_HZ,
  CURSOR_MAX_HZ,
  TREE_MAX_HZ,
  TokenBucket,
  TrailingThrottle,
  minIntervalMsForHz,
  monotonicClock,
  type Clock,
} from "../rateLimiter.js";
import type { RoomManager } from "./roomManager.js";

export type StreamingServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type StreamingSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/* ------------------------------------------------------------------ */
/* Limits and validation                                               */
/* ------------------------------------------------------------------ */

export const MAX_PATH_LENGTH = 1024;
export const MAX_NODE_NAME_LENGTH = 255;
/**
 * Buffer size cap in UTF-16 code units. Worst case on the wire is 6 bytes per
 * unit (a control character escaped as \u00XX), i.e. 1.2MB, which stays under
 * the 2MB `maxHttpBufferSize` configured in server.ts.
 */
export const MAX_BUFFER_CHARS = 200_000;
export const MAX_TREE_NODES = 5_000;
export const MAX_TREE_DEPTH = 32;
const MAX_CURSOR_LINE = 10_000_000;
const MAX_CURSOR_COLUMN = 100_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty, bounded path string without NUL bytes. */
export function parsePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return undefined;
  }
  return value.includes("\u0000") ? undefined : value;
}

export function parsePosition(value: unknown): CursorPosition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const line = value["line"];
  const column = value["column"];
  if (
    typeof line !== "number" ||
    typeof column !== "number" ||
    !Number.isInteger(line) ||
    !Number.isInteger(column) ||
    line < 1 ||
    line > MAX_CURSOR_LINE ||
    column < 1 ||
    column > MAX_CURSOR_COLUMN
  ) {
    return undefined;
  }
  return { line, column };
}

interface TreeBudget {
  remaining: number;
}

function parseTreeNode(value: unknown, depth: number, budget: TreeBudget): FsTreeNode | undefined {
  if (depth > MAX_TREE_DEPTH || budget.remaining <= 0 || !isRecord(value)) {
    return undefined;
  }
  budget.remaining -= 1;

  const name = value["name"];
  const path = value["path"];
  const kind = value["kind"];
  if (typeof name !== "string" || name.length > MAX_NODE_NAME_LENGTH) {
    return undefined;
  }
  // The workspace root has path "", so only length and NUL are checked here.
  if (typeof path !== "string" || path.length > MAX_PATH_LENGTH || path.includes("\u0000")) {
    return undefined;
  }
  if (kind !== "file" && kind !== "directory") {
    return undefined;
  }
  if (kind === "file") {
    return { name, path, kind };
  }

  const rawChildren = value["children"];
  if (rawChildren === undefined) {
    return { name, path, kind };
  }
  if (!Array.isArray(rawChildren)) {
    return undefined;
  }
  const children: FsTreeNode[] = [];
  for (const rawChild of rawChildren as unknown[]) {
    const child = parseTreeNode(rawChild, depth + 1, budget);
    if (!child) {
      return undefined;
    }
    children.push(child);
  }
  return { name, path, kind, children };
}

/**
 * Validates an untrusted tree and returns a clean copy containing only the
 * known fields, or undefined if it is malformed or exceeds the node/depth caps.
 */
export function parseTree(value: unknown): FsTreeNode | undefined {
  return parseTreeNode(value, 0, { remaining: MAX_TREE_NODES });
}

/* ------------------------------------------------------------------ */
/* Per-room snapshot store                                             */
/* ------------------------------------------------------------------ */

interface RoomSyncState {
  seq: number;
  activePath: string | null;
  buffer: EditorBufferState | null;
  tree: FsTreeNode | null;
  cursor: EditorCursorState | null;
}

/**
 * The latest host-side editor state per room. This is what makes a viewer's
 * (re)connect cheap: instead of replaying history, the server hands the
 * viewer the current state in one message.
 *
 * `seq` is a per-room broadcast counter. It is bumped for every `editor:*`
 * event the server sends, and a snapshot records the value it was taken at,
 * so a client can tell which later events are newer than its snapshot.
 */
export class RoomSyncStore {
  private readonly rooms = new Map<string, RoomSyncState>();
  private readonly wallClock: () => number;

  constructor(wallClock: () => number = Date.now) {
    this.wallClock = wallClock;
  }

  /** Read-only view of a room's state, or undefined if the host has sent nothing yet. */
  read(sessionId: string): Readonly<RoomSyncState> | undefined {
    return this.rooms.get(sessionId);
  }

  /** Switches the active file. State that belonged to the previous file is dropped. */
  setActivePath(sessionId: string, path: string | null): void {
    const state = this.ensure(sessionId);
    state.activePath = path;
    if (state.buffer !== null && state.buffer.path !== path) {
      state.buffer = null;
    }
    if (state.cursor !== null && state.cursor.path !== path) {
      state.cursor = null;
    }
  }

  setBuffer(sessionId: string, buffer: EditorBufferState): void {
    this.ensure(sessionId).buffer = buffer;
  }

  setTree(sessionId: string, tree: FsTreeNode): void {
    this.ensure(sessionId).tree = tree;
  }

  setCursor(sessionId: string, cursor: EditorCursorState): void {
    this.ensure(sessionId).cursor = cursor;
  }

  /** Returns the next broadcast sequence number for a room. */
  nextSeq(sessionId: string): number {
    const state = this.ensure(sessionId);
    state.seq += 1;
    return state.seq;
  }

  /** The full current state of a room. A room the host has not touched yet yields an empty snapshot. */
  snapshot(sessionId: string): SyncSnapshot {
    const state = this.rooms.get(sessionId);
    return {
      sessionId,
      seq: state?.seq ?? 0,
      activePath: state?.activePath ?? null,
      buffer: state?.buffer ?? null,
      tree: state?.tree ?? null,
      cursor: state?.cursor ?? null,
      serverTime: this.wallClock(),
    };
  }

  delete(sessionId: string): void {
    this.rooms.delete(sessionId);
  }

  get size(): number {
    return this.rooms.size;
  }

  private ensure(sessionId: string): RoomSyncState {
    let state = this.rooms.get(sessionId);
    if (!state) {
      state = { seq: 0, activePath: null, buffer: null, tree: null, cursor: null };
      this.rooms.set(sessionId, state);
    }
    return state;
  }
}

/* ------------------------------------------------------------------ */
/* Throttled broadcaster                                               */
/* ------------------------------------------------------------------ */

interface SessionChannel {
  readonly hostSocketId: string;
  readonly buffer: TrailingThrottle;
  readonly cursor: TrailingThrottle;
  readonly tree: TrailingThrottle;
}

/**
 * Turns accepted host updates into `editor:*` broadcasts to the room's
 * viewers.
 *
 * Every publish method first writes the update into the RoomSyncStore, so a
 * snapshot is always current, and then asks a TrailingThrottle to broadcast.
 * The throttles carry no payload: when one fires it reads the latest state,
 * so a burst of updates collapses into one broadcast of the newest value and
 * a delayed broadcast can never be stale.
 *
 * The host's own socket is excluded from broadcasts; it already has the state.
 */
export class HostEmitters {
  private readonly io: StreamingServer;
  private readonly store: RoomSyncStore;
  private readonly clock: Clock;
  private readonly channels = new Map<string, SessionChannel>();

  constructor(io: StreamingServer, store: RoomSyncStore, clock: Clock = monotonicClock) {
    this.io = io;
    this.store = store;
    this.clock = clock;
  }

  /** The active path the host last announced: undefined means nothing yet, null means no file open. */
  activePath(sessionId: string): string | null | undefined {
    return this.store.read(sessionId)?.activePath;
  }

  /** Active-file changes are discrete user actions, so they are broadcast immediately. */
  publishActiveFile(sessionId: string, hostSocketId: string, path: string | null): void {
    const previous = this.store.read(sessionId)?.activePath;
    if (previous === path) {
      return;
    }
    const channel = this.channelFor(sessionId, hostSocketId);
    this.store.setActivePath(sessionId, path);
    // Anything still waiting to be sent belongs to the previous file.
    channel.buffer.cancel();
    channel.cursor.cancel();
    const seq = this.store.nextSeq(sessionId);
    this.io.to(sessionId).except(hostSocketId).emit("editor:active-file", { sessionId, seq, path });
  }

  publishBuffer(sessionId: string, hostSocketId: string, buffer: EditorBufferState): void {
    const channel = this.channelFor(sessionId, hostSocketId);
    this.store.setBuffer(sessionId, buffer);
    channel.buffer.trigger();
  }

  publishTree(sessionId: string, hostSocketId: string, tree: FsTreeNode): void {
    const channel = this.channelFor(sessionId, hostSocketId);
    this.store.setTree(sessionId, tree);
    channel.tree.trigger();
  }

  publishCursor(sessionId: string, hostSocketId: string, path: string, position: CursorPosition): void {
    const channel = this.channelFor(sessionId, hostSocketId);
    // Stamped on receipt so a snapshot never carries a placeholder; the broadcast restamps it.
    this.store.setCursor(sessionId, { path, position, emittedAt: this.clock() });
    channel.cursor.trigger();
  }

  /** Stops every pending broadcast for a session and forgets its state. */
  disposeSession(sessionId: string): void {
    const channel = this.channels.get(sessionId);
    if (channel) {
      channel.buffer.cancel();
      channel.cursor.cancel();
      channel.tree.cancel();
      this.channels.delete(sessionId);
    }
    this.store.delete(sessionId);
  }

  get activeChannelCount(): number {
    return this.channels.size;
  }

  private channelFor(sessionId: string, hostSocketId: string): SessionChannel {
    const existing = this.channels.get(sessionId);
    if (existing) {
      return existing;
    }
    const channel: SessionChannel = {
      hostSocketId,
      buffer: new TrailingThrottle(
        minIntervalMsForHz(BUFFER_MAX_HZ),
        () => this.emitBuffer(sessionId, hostSocketId),
        { now: this.clock },
      ),
      cursor: new TrailingThrottle(
        minIntervalMsForHz(CURSOR_MAX_HZ),
        () => this.emitCursor(sessionId, hostSocketId),
        { now: this.clock },
      ),
      tree: new TrailingThrottle(
        minIntervalMsForHz(TREE_MAX_HZ),
        () => this.emitTree(sessionId, hostSocketId),
        { now: this.clock },
      ),
    };
    this.channels.set(sessionId, channel);
    return channel;
  }

  private emitBuffer(sessionId: string, hostSocketId: string): void {
    const buffer = this.store.read(sessionId)?.buffer;
    if (!buffer) {
      return;
    }
    const seq = this.store.nextSeq(sessionId);
    this.io.to(sessionId).except(hostSocketId).emit("editor:buffer", { sessionId, seq, buffer });
  }

  private emitTree(sessionId: string, hostSocketId: string): void {
    const tree = this.store.read(sessionId)?.tree;
    if (!tree) {
      return;
    }
    const seq = this.store.nextSeq(sessionId);
    this.io.to(sessionId).except(hostSocketId).emit("editor:tree", { sessionId, seq, tree });
  }

  private emitCursor(sessionId: string, hostSocketId: string): void {
    const stored = this.store.read(sessionId)?.cursor;
    if (!stored) {
      return;
    }
    // Stamp the broadcast time and store it, so a snapshot carries the same value.
    const cursor: EditorCursorState = { ...stored, emittedAt: this.clock() };
    this.store.setCursor(sessionId, cursor);
    const seq = this.store.nextSeq(sessionId);
    this.io.to(sessionId).except(hostSocketId).emit("editor:cursor", { sessionId, seq, cursor });
  }
}

/* ------------------------------------------------------------------ */
/* Socket handlers                                                     */
/* ------------------------------------------------------------------ */

export interface HostHandlerDeps {
  readonly roomManager: RoomManager;
  readonly emitters: HostEmitters;
}

/**
 * Registers the `host:*` events on a socket. Every event is checked three
 * ways before it touches room state: the socket must be the host of the
 * session it names and still be in its room, the payload must have exactly
 * the expected shape and size, and (for the heavier events) the socket must
 * be within its ingest budget.
 *
 * Cursor updates have no ingest budget on purpose. They are "latest value
 * wins" and are coalesced by the broadcaster, so a client that sends too many
 * cannot make the server drop its final position or fan out more than
 * CURSOR_MAX_HZ updates per second.
 */
export function registerHostHandlers(socket: StreamingSocket, deps: HostHandlerDeps): void {
  // 40-event burst, 20/s sustained, shared by active-file, buffer and tree.
  const ingest = new TokenBucket({ capacity: 40, refillPerSecond: 20 });
  // Error replies are rate-limited too, so a misbehaving client cannot turn
  // the server into an amplifier.
  const errorReplies = new TokenBucket({ capacity: 5, refillPerSecond: 1 });

  function reject(message: string): void {
    if (errorReplies.tryConsume()) {
      socket.emit("session:error", { message });
    }
  }

  /** Returns the session id if this socket may send host events for it. */
  function authorizeHost(claimedSessionId: unknown): string | undefined {
    const ownSessionId = socket.data.sessionId;
    if (socket.data.role !== "host" || ownSessionId === undefined) {
      reject("Only the host of a session can send host events.");
      return undefined;
    }
    if (claimedSessionId !== ownSessionId) {
      reject("Session id does not match this connection's session.");
      return undefined;
    }
    const session = deps.roomManager.getSessionById(ownSessionId);
    if (!session || session.state === "ended" || !socket.rooms.has(ownSessionId)) {
      reject("Session not found or has ended.");
      return undefined;
    }
    return session.id;
  }

  function admit(): boolean {
    if (ingest.tryConsume()) {
      return true;
    }
    reject("Rate limit exceeded: send active-file, buffer and tree updates at most ~20 times per second.");
    return false;
  }

  socket.on("host:active-file", (raw: unknown) => {
    if (!isRecord(raw)) {
      reject("Malformed host:active-file payload.");
      return;
    }
    const sessionId = authorizeHost(raw["sessionId"]);
    if (sessionId === undefined || !admit()) {
      return;
    }
    const rawPath = raw["path"];
    const path = rawPath === null ? null : parsePath(rawPath);
    if (path === undefined) {
      reject("host:active-file needs a path of 1 to 1024 characters, or null.");
      return;
    }
    deps.emitters.publishActiveFile(sessionId, socket.id, path);
  });

  socket.on("host:buffer", (raw: unknown) => {
    if (!isRecord(raw)) {
      reject("Malformed host:buffer payload.");
      return;
    }
    const sessionId = authorizeHost(raw["sessionId"]);
    if (sessionId === undefined || !admit()) {
      return;
    }
    const path = parsePath(raw["path"]);
    const content = raw["content"];
    const version = raw["version"];
    if (
      path === undefined ||
      typeof content !== "string" ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0
    ) {
      reject("Malformed host:buffer payload.");
      return;
    }
    if (content.length > MAX_BUFFER_CHARS) {
      reject(`Buffer is larger than ${MAX_BUFFER_CHARS} characters and was not shared.`);
      return;
    }
    if (deps.emitters.activePath(sessionId) !== path) {
      reject("host:buffer must be for the active file; send host:active-file first.");
      return;
    }
    deps.emitters.publishBuffer(sessionId, socket.id, { path, content, version });
  });

  socket.on("host:tree", (raw: unknown) => {
    if (!isRecord(raw)) {
      reject("Malformed host:tree payload.");
      return;
    }
    const sessionId = authorizeHost(raw["sessionId"]);
    if (sessionId === undefined || !admit()) {
      return;
    }
    const tree = parseTree(raw["tree"]);
    if (!tree) {
      reject(`host:tree is malformed or exceeds ${MAX_TREE_NODES} nodes / depth ${MAX_TREE_DEPTH}.`);
      return;
    }
    deps.emitters.publishTree(sessionId, socket.id, tree);
  });

  socket.on("host:cursor", (raw: unknown) => {
    if (!isRecord(raw)) {
      reject("Malformed host:cursor payload.");
      return;
    }
    const sessionId = authorizeHost(raw["sessionId"]);
    if (sessionId === undefined) {
      return;
    }
    const path = parsePath(raw["path"]);
    const position = parsePosition(raw["position"]);
    if (path === undefined || position === undefined) {
      reject("Malformed host:cursor payload.");
      return;
    }
    if (deps.emitters.activePath(sessionId) !== path) {
      reject("host:cursor must be for the active file; send host:active-file first.");
      return;
    }
    deps.emitters.publishCursor(sessionId, socket.id, path, position);
  });
}