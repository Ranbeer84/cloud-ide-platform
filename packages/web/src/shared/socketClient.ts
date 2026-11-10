import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@live/shared-types";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const STREAMING_URL =
  (import.meta.env["VITE_STREAMING_URL"] as string | undefined) ??
  "http://localhost:4000";

let socket: AppSocket | undefined;

/**
 * Lazily creates (and reuses) a single typed socket connection per tab.
 *
 * WebSocket only: one persistent connection to one streaming replica, so the
 * load balancer needs no cookie. The default polling-first handshake sends
 * several HTTP requests that must all reach the same replica, and a sticky
 * cookie is not sent on cross-origin requests, so with more than one
 * streaming replica the handshake could fail intermittently.
 */
export function getSocket(): AppSocket {
  socket ??= io(STREAMING_URL, { autoConnect: true, transports: ["websocket"] });
  return socket;
}