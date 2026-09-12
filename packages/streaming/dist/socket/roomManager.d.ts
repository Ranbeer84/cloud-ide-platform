import type { Session, SessionUpdatableFields } from "@live/shared-types";
/**
 * Owns all session state for the streaming server. Kept as a small,
 * dependency-free class so it can be unit tested without a real socket.
 */
export declare class RoomManager {
    private readonly roomsByCode;
    private readonly roomsById;
    createSession(hostSocketId: string, topic: string): Session;
    joinSession(code: string, viewerSocketId: string): Session | undefined;
    updateSession(sessionId: string, hostSocketId: string, patch: Partial<SessionUpdatableFields>): Session | undefined;
    leaveSession(sessionId: string, socketId: string): Session | undefined;
    /** Ends and removes any session hosted by this socket (e.g. on disconnect). */
    endSessionByHost(hostSocketId: string): Session | undefined;
    getSessionById(sessionId: string): Session | undefined;
}
//# sourceMappingURL=roomManager.d.ts.map