import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@live/shared-types";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const STREAMING_URL =
  (import.meta.env["VITE_STREAMING_URL"] as string | undefined) ??
  "http://localhost:4000";

let socket: AppSocket | undefined;

/** Lazily creates (and reuses) a single typed socket connection per tab. */
export function getSocket(): AppSocket {
  socket ??= io(STREAMING_URL, { autoConnect: true });
  return socket;
}
