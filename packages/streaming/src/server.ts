import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@live/shared-types";
import {
  attachRedisAdapter,
  ClusterBridge,
  createClusterLogger,
  LocalOnlyRooms,
  type ClusterLocalRooms,
  type ClusterRooms,
  type RedisAdapterHandle,
} from "./redisAdapter.js";
import {
  HostEmitters,
  RoomSyncStore,
  registerHostHandlers,
  type StreamingSocket,
} from "./socket/hostHandlers.js";
import { RoomManager } from "./socket/roomManager.js";
import { registerViewerHandlers, sendSnapshot } from "./socket/viewerHandlers.js";

const PORT = Number(process.env["PORT"] ?? 4000);
const WEB_ORIGIN = process.env["WEB_ORIGIN"] ?? "http://localhost:5173";
/** Unset means single-node mode: no Redis, no cross-node routing (Phases 0-7 behaviour). */
const REDIS_URL = process.env["REDIS_URL"]?.trim() ?? "";
const REDIS_KEY_PREFIX = process.env["REDIS_KEY_PREFIX"]?.trim() || "live:";
const NODE_ID = process.env["STREAMING_NODE_ID"]?.trim() || process.env["HOSTNAME"]?.trim() || randomUUID().slice(0, 8);
const PEER_TIMEOUT_MS = Number(process.env["CLUSTER_PEER_TIMEOUT_MS"] ?? 2_000);
/**
 * On SIGTERM the node reports unhealthy first, then waits this long before
 * disconnecting clients, so the load balancer has stopped sending it new
 * connections by the time existing ones are asked to reconnect elsewhere.
 */
const SHUTDOWN_DRAIN_MS = Number(process.env["SHUTDOWN_DRAIN_MS"] ?? 0);
const SHUTDOWN_FORCE_EXIT_MS = 15_000;

const logger = createClusterLogger(NODE_ID);

async function start(): Promise<void> {
  const app = express();
  app.use(cors({ origin: WEB_ORIGIN }));

  const httpServer = createServer(app);

  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: { origin: WEB_ORIGIN },
    // A host buffer is capped at 200,000 characters (see hostHandlers.ts), which
    // is at most ~1.2MB once JSON-escaped. 2MB leaves headroom; a larger packet
    // makes Socket.IO close the connection instead of delivering it.
    maxHttpBufferSize: 2 * 1024 * 1024,
  });

  const roomManager = new RoomManager();
  const syncStore = new RoomSyncStore();
  const hostEmitters = new HostEmitters(io, syncStore);

  // What this node can answer about the rooms it owns (their host is connected here).
  const localRooms: ClusterLocalRooms = {
    joinByCode(code, viewerSocketId) {
      const session = roomManager.joinSession(code, viewerSocketId);
      return session ? { session, snapshot: syncStore.snapshot(session.id) } : undefined;
    },
    viewOf(sessionId) {
      const session = roomManager.getSessionById(sessionId);
      if (!session || session.state === "ended") {
        return undefined;
      }
      return { session, snapshot: syncStore.snapshot(session.id) };
    },
    leave(sessionId, viewerSocketId) {
      return roomManager.leaveSession(sessionId, viewerSocketId);
    },
  };

  let adapter: RedisAdapterHandle | undefined;
  let rooms: ClusterRooms = new LocalOnlyRooms(localRooms);
  if (REDIS_URL.length > 0) {
    adapter = await attachRedisAdapter(io, {
      url: REDIS_URL,
      keyPrefix: REDIS_KEY_PREFIX,
      nodeId: NODE_ID,
      peerTimeoutMs: PEER_TIMEOUT_MS,
      logger,
    });
    rooms = new ClusterBridge(io, localRooms, logger);
  } else {
    logger.info("cluster.single_node", { message: "REDIS_URL is not set: rooms are only visible on this node." });
  }

  let draining = false;

  app.get("/health", (_req, res) => {
    if (draining) {
      res.status(503).json({ ok: false, draining: true, node: NODE_ID });
      return;
    }
    if (!adapter) {
      res.json({ ok: true, node: NODE_ID, clustered: false });
      return;
    }
    const handle = adapter;
    Promise.all([handle.ping(), handle.nodeCount().catch(() => 0)])
      .then(([redis, nodes]) => {
        res.json({ ok: true, node: NODE_ID, clustered: true, redis, nodes });
      })
      .catch(() => {
        res.json({ ok: true, node: NODE_ID, clustered: true, redis: false, nodes: 0 });
      });
  });

  function registerSessionHandlers(socket: StreamingSocket): void {
    socket.on("session:create", (request, ack) => {
      const session = roomManager.createSession(socket.id, request.topic);
      socket.data.sessionId = session.id;
      socket.data.role = "host";
      void socket.join(session.id);
      ack({ ok: true, session });
    });

    socket.on("session:join", (request, ack) => {
      if (typeof ack !== "function") {
        return;
      }
      const code: unknown = (request as { code?: unknown } | null | undefined)?.code;
      if (typeof code !== "string" || code.length === 0 || code.length > 32) {
        ack({ ok: false, error: "Session not found or has ended." });
        return;
      }
      rooms
        .joinByCode(code, socket.id)
        .then(async (view) => {
          if (!view) {
            ack({ ok: false, error: "Session not found or has ended." });
            return;
          }
          socket.data.sessionId = view.session.id;
          socket.data.role = "viewer";
          await socket.join(view.session.id);
          ack({ ok: true, session: view.session });
          // Same tick as the ack: the viewer gets the host's current buffer, file
          // tree and caret immediately, not after a further request.
          socket.emit("sync:snapshot", view.snapshot);
          io.to(view.session.id).emit("session:state", view.session);
        })
        .catch((error: unknown) => {
          logger.error("session.join_failed", { message: error instanceof Error ? error.message : String(error) });
          ack({ ok: false, error: "Could not join the session right now; retry in a moment." });
        });
    });

    socket.on("session:update", (request, ack) => {
      const session = roomManager.updateSession(
        request.sessionId,
        socket.id,
        request.patch,
      );
      if (!session) {
        ack({ ok: false, error: "Not authorized to update this session." });
        return;
      }
      ack({ ok: true, session });
      io.to(session.id).emit("session:state", session);
    });

    socket.on("session:leave", (request) => {
      void socket.leave(request.sessionId);
      rooms
        .leave(request.sessionId, socket.id)
        .then((session) => {
          if (session) {
            io.to(session.id).emit("session:state", session);
          }
        })
        .catch((error: unknown) => {
          logger.warn("session.leave_failed", { message: error instanceof Error ? error.message : String(error) });
        });
    });

    socket.on("disconnect", () => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) {
        return;
      }
      if (socket.data.role === "host") {
        const ended = roomManager.endSessionByHost(socket.id);
        if (ended) {
          io.to(ended.id).emit("session:ended", { sessionId: ended.id });
          hostEmitters.disposeSession(ended.id);
        }
      } else {
        rooms
          .leave(sessionId, socket.id)
          .then((session) => {
            if (session) {
              io.to(session.id).emit("session:state", session);
            }
          })
          .catch((error: unknown) => {
            logger.warn("session.leave_failed", { message: error instanceof Error ? error.message : String(error) });
          });
      }
    });
  }

  io.on("connection", (socket) => {
    registerSessionHandlers(socket);
    registerHostHandlers(socket, { roomManager, emitters: hostEmitters });
    registerViewerHandlers(socket, { rooms });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(PORT, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  logger.info("streaming.listening", { port: PORT, clustered: adapter !== undefined });

  /**
   * Graceful stop, in this order: (1) /health starts answering 503 so the
   * load balancer stops choosing this node, (2) optional drain wait, (3)
   * io.close() disconnects every client, which runs each disconnect handler
   * (a host's room ends and its viewers on every node are told) while the
   * adapter is still attached, (4) the adapter detaches from Redis.
   */
  let stopping: Promise<void> | undefined;
  const shutdown = (signal: string): void => {
    stopping ??= (async () => {
      logger.info("streaming.shutdown", { signal, drainMs: SHUTDOWN_DRAIN_MS });
      draining = true;
      if (SHUTDOWN_DRAIN_MS > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
      }
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      await adapter?.close();
      logger.info("streaming.stopped");
    })();
    const force = setTimeout(() => process.exit(1), SHUTDOWN_FORCE_EXIT_MS);
    force.unref();
    stopping.then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  logger.error("streaming.startup_failed", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});