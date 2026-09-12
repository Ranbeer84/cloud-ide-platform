import type { Session, SessionUpdatableFields } from "./session.js";
/** Payload sent by a host to create a brand new session. */
export interface CreateSessionRequest {
    readonly topic: string;
}
/** Payload sent by a viewer to join an existing session by its code. */
export interface JoinSessionRequest {
    readonly code: string;
}
/** Payload sent by the host to mutate the session's mutable fields. */
export interface UpdateSessionRequest {
    readonly sessionId: string;
    readonly patch: Partial<SessionUpdatableFields>;
}
/** Payload sent by either role to leave a session's room. */
export interface LeaveSessionRequest {
    readonly sessionId: string;
}
/** Generic error payload returned to the caller on failure. */
export interface SocketErrorPayload {
    readonly message: string;
}
/** Acknowledgement shape returned by request/response style events. */
export type SessionAck = {
    readonly ok: true;
    readonly session: Session;
} | {
    readonly ok: false;
    readonly error: string;
};
/** Events the client emits and the server listens for. */
export interface ClientToServerEvents {
    "session:create": (request: CreateSessionRequest, ack: (response: SessionAck) => void) => void;
    "session:join": (request: JoinSessionRequest, ack: (response: SessionAck) => void) => void;
    "session:update": (request: UpdateSessionRequest, ack: (response: SessionAck) => void) => void;
    "session:leave": (request: LeaveSessionRequest) => void;
}
/** Events the server emits and the client listens for. */
export interface ServerToClientEvents {
    "session:state": (session: Session) => void;
    "session:ended": (payload: {
        readonly sessionId: string;
    }) => void;
    "session:error": (payload: SocketErrorPayload) => void;
}
/** No inter-server events are used in this prototype. */
export interface InterServerEvents {
}
/** Per-socket data attached by the server (e.g. after a join/create). */
export interface SocketData {
    sessionId?: string;
    role?: "host" | "viewer";
}
//# sourceMappingURL=socketEvents.d.ts.map