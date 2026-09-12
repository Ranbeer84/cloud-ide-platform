/**
 * Lifecycle of a live session.
 * - waiting: created by the host, no viewers streaming yet
 * - live: host has started the session, viewers receive live updates
 * - ended: host has closed the session, no further updates will be sent
 */
export type SessionState = "waiting" | "live" | "ended";
/**
 * A live session hosted by one user and observed by zero or more viewers.
 * `code` is the short, human-shareable identifier viewers use to join.
 */
export interface Session {
    readonly id: string;
    readonly code: string;
    readonly hostId: string;
    readonly topic: string;
    readonly state: SessionState;
    readonly createdAt: number;
    readonly viewerCount: number;
}
/** Fields a host is allowed to mutate after creation. */
export type SessionUpdatableFields = Pick<Session, "topic" | "state">;
//# sourceMappingURL=session.d.ts.map