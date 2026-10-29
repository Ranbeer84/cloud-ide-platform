import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import type { Server } from "socket.io";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  Session,
  SocketData,
  SyncSnapshot,
} from "@live/shared-types";

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export type ClusterLogFields = Readonly<Record<string, unknown>>;

export interface ClusterLogger {
  info(message: string, fields?: ClusterLogFields): void;
  warn(message: string, fields?: ClusterLogFields): void;
  error(message: string, fields?: ClusterLogFields): void;
}

/** One JSON object per line, matching the orchestrator's log format. */
export function createClusterLogger(nodeId: string): ClusterLogger {
  const write = (level: "info" | "warn" | "error", message: string, fields?: ClusterLogFields): void => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      svc: "streaming",
      node: nodeId,
      msg: message,
      ...(fields ?? {}),
    });
    if (level === "info") {
      process.stdout.write(`${line}\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

/* ------------------------------------------------------------------ */
/* Cross-node room directory                                           */
/* ------------------------------------------------------------------ */

/** A room as seen by a viewer: the session plus the host's current editor state. */
export interface ClusterRoomView {
  readonly session: Session;
  readonly snapshot: SyncSnapshot;
}

/**
 * What one node can answer about the rooms it owns. A room is owned by the
 * node its host is connected to: that node holds the RoomManager record, the
 * RoomSyncStore state and the throttled broadcasters. server.ts implements
 * this on top of RoomManager and RoomSyncStore.
 */
export interface ClusterLocalRooms {
  /** Registers `viewerSocketId` as a viewer of the room with this code, if this node owns it. */
  joinByCode(code: string, viewerSocketId: string): ClusterRoomView | undefined;
  /** Current session and snapshot of a room this node owns (undefined if not owned here or ended). */
  viewOf(sessionId: string): ClusterRoomView | undefined;
  /** Removes a viewer from a room this node owns. Returns the updated session if the room is owned here. */
  leave(sessionId: string, viewerSocketId: string): Session | undefined;
}

/**
 * The operations socket handlers use. They behave the same whether the room
 * lives on this node or on a peer, and whether or not Redis is configured.
 */
export interface ClusterRooms {
  joinByCode(code: string, viewerSocketId: string): Promise<ClusterRoomView | undefined>;
  resync(sessionId: string): Promise<ClusterRoomView | undefined>;
  /**
   * Removes a viewer. If the room is owned by this node the updated session is
   * returned and the caller broadcasts it. If a peer owns it, the peer is
   * told and broadcasts it itself, so undefined is returned.
   */
  leave(sessionId: string, viewerSocketId: string): Promise<Session | undefined>;
}

/** Single-node implementation, used when no REDIS_URL is configured. */
export class LocalOnlyRooms implements ClusterRooms {
  private readonly local: ClusterLocalRooms;

  constructor(local: ClusterLocalRooms) {
    this.local = local;
  }

  joinByCode(code: string, viewerSocketId: string): Promise<ClusterRoomView | undefined> {
    return Promise.resolve(this.local.joinByCode(code, viewerSocketId));
  }

  resync(sessionId: string): Promise<ClusterRoomView | undefined> {
    return Promise.resolve(this.local.viewOf(sessionId));
  }

  leave(sessionId: string, viewerSocketId: string): Promise<Session | undefined> {
    return Promise.resolve(this.local.leave(sessionId, viewerSocketId));
  }
}

/* ------------------------------------------------------------------ */
/* Inter-node protocol                                                 */
/* ------------------------------------------------------------------ */

export type ClusterRoomReply =
  | { readonly found: true; readonly session: Session; readonly snapshot: SyncSnapshot }
  | { readonly found: false };

export interface ClusterJoinRequest {
  readonly code: string;
  readonly viewerSocketId: string;
}

export interface ClusterResyncRequest {
  readonly sessionId: string;
}

export interface ClusterLeaveRequest {
  readonly sessionId: string;
  readonly viewerSocketId: string;
}

/**
 * Events streaming nodes send each other through the adapter
 * (io.serverSideEmit). Browsers can never emit these: they only travel
 * between servers over Redis.
 */
export interface ClusterEvents {
  "cluster:join": (request: ClusterJoinRequest, ack: (reply: ClusterRoomReply) => void) => void;
  "cluster:resync": (request: ClusterResyncRequest, ack: (reply: ClusterRoomReply) => void) => void;
  "cluster:leave": (request: ClusterLeaveRequest) => void;
}

type ClusterServer = Server<ClientToServerEvents, ServerToClientEvents, ClusterEvents, SocketData>;
export type StreamingIo = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Looks a room up on this node first, then asks every peer.
 *
 * Redis pub/sub and the Socket.IO adapter already make `io.to(room).emit()`
 * reach sockets on every node, so live editor events need nothing more. What
 * the adapter does not share is the room's own state, which lives in one
 * node's memory. This bridge covers the three moments a viewer on another
 * node needs that state: joining by code, an explicit resync, and leaving.
 *
 * Known limits, by design of the in-memory room state:
 *  - A room lives and dies with its host's node. If that node stops, the
 *    host's disconnect ends the room (on a graceful stop viewers on other
 *    nodes receive `session:ended`); after a crash they do not, and the
 *    client's resync fails with "Session not found".
 *  - Join codes are unique per node, not across the cluster. A collision
 *    between two live rooms on different nodes (1 in about a billion per
 *    pair) lets the first answering node win.
 */
export class ClusterBridge implements ClusterRooms {
  private readonly io: ClusterServer;
  private readonly local: ClusterLocalRooms;
  private readonly logger: ClusterLogger;

  constructor(io: StreamingIo, local: ClusterLocalRooms, logger: ClusterLogger) {
    // The only place the inter-server event map is widened. StreamingIo and
    // ClusterServer are the same object; they differ only in the type-level
    // map of server-to-server events.
    this.io = io as unknown as ClusterServer;
    this.local = local;
    this.logger = logger;

    this.io.on("cluster:join", (request, ack) => {
      const view = this.local.joinByCode(request.code, request.viewerSocketId);
      ack(view ? { found: true, session: view.session, snapshot: view.snapshot } : { found: false });
    });

    this.io.on("cluster:resync", (request, ack) => {
      const view = this.local.viewOf(request.sessionId);
      ack(view ? { found: true, session: view.session, snapshot: view.snapshot } : { found: false });
    });

    this.io.on("cluster:leave", (request) => {
      const session = this.local.leave(request.sessionId, request.viewerSocketId);
      if (session) {
        this.io.to(session.id).emit("session:state", session);
      }
    });
  }

  async joinByCode(code: string, viewerSocketId: string): Promise<ClusterRoomView | undefined> {
    const here = this.local.joinByCode(code, viewerSocketId);
    if (here) {
      return here;
    }
    const replies = await this.askPeers("join", () =>
      this.io.serverSideEmitWithAck("cluster:join", { code, viewerSocketId }),
    );
    return firstFound(replies);
  }

  async resync(sessionId: string): Promise<ClusterRoomView | undefined> {
    const here = this.local.viewOf(sessionId);
    if (here) {
      return here;
    }
    const replies = await this.askPeers("resync", () =>
      this.io.serverSideEmitWithAck("cluster:resync", { sessionId }),
    );
    return firstFound(replies);
  }

  async leave(sessionId: string, viewerSocketId: string): Promise<Session | undefined> {
    const here = this.local.leave(sessionId, viewerSocketId);
    if (here) {
      return here;
    }
    // Not ours: tell the peers. Only the owner has a record to update, and it
    // broadcasts the new viewer count itself.
    this.io.serverSideEmit("cluster:leave", { sessionId, viewerSocketId });
    return undefined;
  }

  /**
   * Waits for every peer's answer. A peer that is down but not yet expired
   * from the adapter's node list makes the request time out (requestsTimeout);
   * the peers that did answer are still used, so one dead node never blocks
   * joins to rooms on a healthy one.
   */
  private async askPeers(
    operation: string,
    send: () => Promise<ClusterRoomReply[]>,
  ): Promise<readonly ClusterRoomReply[]> {
    try {
      return await send();
    } catch (error) {
      const partial = (error as { responses?: unknown }).responses;
      this.logger.warn("cluster.peer_request_incomplete", { operation, message: describeError(error) });
      return Array.isArray(partial) ? (partial as ClusterRoomReply[]) : [];
    }
  }
}

function firstFound(replies: readonly ClusterRoomReply[]): ClusterRoomView | undefined {
  for (const reply of replies) {
    if (reply.found) {
      return { session: reply.session, snapshot: reply.snapshot };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Redis adapter                                                       */
/* ------------------------------------------------------------------ */

export interface RedisAdapterOptions {
  /** redis:// or rediss:// URL (include the password here). */
  readonly url: string;
  /** Prefix for the adapter's pub/sub channels, e.g. "live:". */
  readonly keyPrefix: string;
  /** Unique, human-readable name of this node, for logs. */
  readonly nodeId: string;
  /** How long a cross-node request waits for peers before using the answers it has. */
  readonly peerTimeoutMs: number;
  readonly logger: ClusterLogger;
}

export interface RedisAdapterHandle {
  readonly nodeId: string;
  /** Round trip to Redis, for /health. */
  ping(): Promise<boolean>;
  /** Number of streaming nodes currently attached to the adapter, this one included. */
  nodeCount(): Promise<number>;
  /** Detaches from Redis. Call after io.close(), so every disconnect handler can still broadcast. */
  close(): Promise<void>;
}

/**
 * Creates an ioredis client for the adapter. Pub/sub needs two connections
 * (a subscribed connection cannot publish). Both give up if Redis is
 * unreachable at boot, so the process fails fast and the orchestrator of the
 * deployment restarts it, and both retry forever once connected so a Redis
 * restart does not need a streaming restart.
 */
function createClient(options: RedisAdapterOptions, role: "pub" | "sub"): Redis {
  let connectedOnce = false;
  const client = new Redis(options.url, {
    lazyConnect: true,
    // A subscriber must never reject a queued command just because Redis blinked.
    maxRetriesPerRequest: role === "sub" ? null : 2,
    retryStrategy: (attempt: number): number | null => {
      if (!connectedOnce && attempt > 10) {
        return null;
      }
      return Math.min(attempt * 200, 2_000);
    },
  });
  client.on("ready", () => {
    connectedOnce = true;
    options.logger.info("redis.ready", { role });
  });
  client.on("error", (error: Error) => {
    options.logger.warn("redis.error", { role, message: error.message });
  });
  client.on("close", () => {
    options.logger.warn("redis.connection_closed", { role });
  });
  return client;
}

/**
 * Connects to Redis and installs @socket.io/redis-adapter on `io`.
 *
 * After this resolves, `io.to(room).emit(...)`, `.except(...)`, `io.in(room)`,
 * `socket.join(...)` and `io.serverSideEmit(...)` all work across every node
 * that shares the same Redis and key prefix. Rejects if Redis is unreachable.
 */
export async function attachRedisAdapter(io: StreamingIo, options: RedisAdapterOptions): Promise<RedisAdapterHandle> {
  const pub = createClient(options, "pub");
  const sub = createClient(options, "sub");

  try {
    await Promise.all([pub.connect(), sub.connect()]);
  } catch (error) {
    pub.disconnect();
    sub.disconnect();
    throw new Error(`Could not connect to Redis for the Socket.IO adapter: ${describeError(error)}`);
  }

  io.adapter(
    createAdapter(pub, sub, {
      key: `${options.keyPrefix}socket.io`,
      requestsTimeout: options.peerTimeoutMs,
    }),
  );
  options.logger.info("redis.adapter_attached", { keyPrefix: options.keyPrefix });

  return {
    nodeId: options.nodeId,
    async ping(): Promise<boolean> {
      try {
        return (await pub.ping()) === "PONG";
      } catch {
        return false;
      }
    },
    async nodeCount(): Promise<number> {
      return io.of("/").adapter.serverCount();
    },
    async close(): Promise<void> {
      await Promise.all([
        pub.quit().catch(() => pub.disconnect()),
        sub.quit().catch(() => sub.disconnect()),
      ]);
      options.logger.info("redis.adapter_closed");
    },
  };
}