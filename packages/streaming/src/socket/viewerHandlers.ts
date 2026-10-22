import type { ResyncAck } from "@live/shared-types";
import { TokenBucket } from "../rateLimiter.js";
import { isRecord, type RoomSyncStore, type StreamingSocket } from "./hostHandlers.js";
import type { RoomManager } from "./roomManager.js";

export interface ViewerHandlerDeps {
  readonly roomManager: RoomManager;
  readonly store: RoomSyncStore;
}

/**
 * Pushes the room's current editor state (active file, buffer, file tree,
 * caret) to one socket.
 *
 * server.ts calls this right after a viewer's `session:join` is acknowledged,
 * in the same tick, so a viewer that reconnects or refreshes receives the
 * host's current state without a second round trip.
 *
 * Client contract for a viewer:
 *  1. On every socket `connect` event (first connect and every reconnect),
 *     emit `session:join` with the session code. A new socket is not in any
 *     room, so reconnecting always means joining again.
 *  2. Apply `sync:snapshot` wholesale, and remember its `seq`.
 *  3. Apply a live `editor:*` event only if its `seq` is greater than the last
 *     `seq` applied. If it jumps by more than one, something was missed:
 *     emit `viewer:resync`.
 */
export function sendSnapshot(socket: StreamingSocket, store: RoomSyncStore, sessionId: string): void {
  socket.emit("sync:snapshot", store.snapshot(sessionId));
}

/**
 * Registers `viewer:resync`: an explicit "send me everything again" request,
 * answered through the acknowledgement. It is limited to a burst of 5 and one
 * per second sustained per socket, because each answer can carry a full
 * buffer and 50 viewers refreshing at once must not be able to multiply that.
 */
export function registerViewerHandlers(socket: StreamingSocket, deps: ViewerHandlerDeps): void {
  const resyncLimiter = new TokenBucket({ capacity: 5, refillPerSecond: 1 });

  socket.on("viewer:resync", (raw: unknown, ack: unknown) => {
    if (typeof ack !== "function") {
      return;
    }
    const reply = ack as (response: ResyncAck) => void;

    if (!isRecord(raw) || typeof raw["sessionId"] !== "string") {
      reply({ ok: false, error: "Malformed resync request." });
      return;
    }
    const claimedSessionId = raw["sessionId"];
    if (
      socket.data.role !== "viewer" ||
      socket.data.sessionId !== claimedSessionId ||
      !socket.rooms.has(claimedSessionId)
    ) {
      reply({ ok: false, error: "Join the session before requesting a resync." });
      return;
    }
    const session = deps.roomManager.getSessionById(claimedSessionId);
    if (!session || session.state === "ended") {
      reply({ ok: false, error: "Session not found or has ended." });
      return;
    }
    if (!resyncLimiter.tryConsume()) {
      reply({ ok: false, error: "Resync rate limit exceeded; retry in a moment." });
      return;
    }
    reply({ ok: true, snapshot: deps.store.snapshot(session.id) });
  });
}