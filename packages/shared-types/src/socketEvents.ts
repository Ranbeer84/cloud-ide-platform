import type { FsTreeNode } from "./fsEvents.js";
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
export type SessionAck =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly error: string };

/* ------------------------------------------------------------------ */
/* Phase 6: editor state streaming                                     */
/* ------------------------------------------------------------------ */

/** 1-based line and column, matching Monaco's position model. */
export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

/** Host -> server: the host opened (or closed, with null) a file. */
export interface HostActiveFileUpdate {
  readonly sessionId: string;
  readonly path: string | null;
}

/** Host -> server: the full text of the host's current buffer. */
export interface HostBufferUpdate {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
  /** Host-side edit counter. Informational; ordering uses the server's seq. */
  readonly version: number;
}

/** Host -> server: the host's current file tree. */
export interface HostTreeUpdate {
  readonly sessionId: string;
  readonly tree: FsTreeNode;
}

/** Host -> server: the host's caret position. */
export interface HostCursorUpdate {
  readonly sessionId: string;
  readonly path: string;
  readonly position: CursorPosition;
}

/** Viewer -> server: ask for a fresh full snapshot of the host's state. */
export interface ViewerResyncRequest {
  readonly sessionId: string;
}

export interface EditorBufferState {
  readonly path: string;
  readonly content: string;
  readonly version: number;
}

export interface EditorCursorState {
  readonly path: string;
  readonly position: CursorPosition;
  /**
   * Server monotonic clock (milliseconds, fractional) at the moment this
   * cursor update was broadcast. Only differences between values are
   * meaningful.
   */
  readonly emittedAt: number;
}

/**
 * The complete state a viewer needs to render the host's editor. Sent right
 * after a viewer joins and on every explicit resync.
 *
 * `seq` is the room's broadcast sequence number at the time of the snapshot.
 * A viewer applies live `editor:*` events only when their `seq` is greater
 * than the `seq` of the snapshot it last applied.
 */
export interface SyncSnapshot {
  readonly sessionId: string;
  readonly seq: number;
  readonly activePath: string | null;
  readonly buffer: EditorBufferState | null;
  readonly tree: FsTreeNode | null;
  readonly cursor: EditorCursorState | null;
  /** Wall-clock milliseconds on the server when the snapshot was taken. */
  readonly serverTime: number;
}

export type ResyncAck =
  | { readonly ok: true; readonly snapshot: SyncSnapshot }
  | { readonly ok: false; readonly error: string };

export interface EditorActiveFileEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly path: string | null;
}

export interface EditorBufferEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly buffer: EditorBufferState;
}

export interface EditorTreeEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly tree: FsTreeNode;
}

export interface EditorCursorEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly cursor: EditorCursorState;
}

/** Events the client emits and the server listens for. */
export interface ClientToServerEvents {
  "session:create": (
    request: CreateSessionRequest,
    ack: (response: SessionAck) => void,
  ) => void;
  "session:join": (
    request: JoinSessionRequest,
    ack: (response: SessionAck) => void,
  ) => void;
  "session:update": (
    request: UpdateSessionRequest,
    ack: (response: SessionAck) => void,
  ) => void;
  "session:leave": (request: LeaveSessionRequest) => void;
  "host:active-file": (update: HostActiveFileUpdate) => void;
  "host:buffer": (update: HostBufferUpdate) => void;
  "host:tree": (update: HostTreeUpdate) => void;
  "host:cursor": (update: HostCursorUpdate) => void;
  "viewer:resync": (
    request: ViewerResyncRequest,
    ack: (response: ResyncAck) => void,
  ) => void;
}

/** Events the server emits and the client listens for. */
export interface ServerToClientEvents {
  "session:state": (session: Session) => void;
  "session:ended": (payload: { readonly sessionId: string }) => void;
  "session:error": (payload: SocketErrorPayload) => void;
  "sync:snapshot": (snapshot: SyncSnapshot) => void;
  "editor:active-file": (event: EditorActiveFileEvent) => void;
  "editor:buffer": (event: EditorBufferEvent) => void;
  "editor:tree": (event: EditorTreeEvent) => void;
  "editor:cursor": (event: EditorCursorEvent) => void;
}

/** No inter-server events are used in this prototype. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface InterServerEvents {}

/** Per-socket data attached by the server (e.g. after a join/create). */
export interface SocketData {
  sessionId?: string;
  role?: "host" | "viewer";
}