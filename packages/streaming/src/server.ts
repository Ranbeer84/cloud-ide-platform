import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server, type Socket } from "socket.io";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@live/shared-types";
import { RoomManager } from "./socket/roomManager.js";

const PORT = Number(process.env["PORT"] ?? 4000);
const WEB_ORIGIN = process.env["WEB_ORIGIN"] ?? "http://localhost:5173";

const app = express();
app.use(cors({ origin: WEB_ORIGIN }));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: { origin: WEB_ORIGIN },
});

const roomManager = new RoomManager();

function registerSessionHandlers(
  socket: Socket<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >,
): void {
  socket.on("session:create", (request, ack) => {
    const session = roomManager.createSession(socket.id, request.topic);
    socket.data.sessionId = session.id;
    socket.data.role = "host";
    void socket.join(session.id);
    ack({ ok: true, session });
  });

  socket.on("session:join", (request, ack) => {
    const session = roomManager.joinSession(request.code, socket.id);
    if (!session) {
      ack({ ok: false, error: "Session not found or has ended." });
      return;
    }
    socket.data.sessionId = session.id;
    socket.data.role = "viewer";
    void socket.join(session.id);
    ack({ ok: true, session });
    io.to(session.id).emit("session:state", session);
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
    const session = roomManager.leaveSession(request.sessionId, socket.id);
    void socket.leave(request.sessionId);
    if (session) {
      io.to(session.id).emit("session:state", session);
    }
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
      }
    } else {
      const session = roomManager.leaveSession(sessionId, socket.id);
      if (session) {
        io.to(session.id).emit("session:state", session);
      }
    }
  });
}

io.on("connection", registerSessionHandlers);

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[streaming] listening on http://localhost:${PORT}`);
});
