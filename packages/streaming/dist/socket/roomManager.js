import { randomUUID } from "node:crypto";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const CODE_LENGTH = 6;
function generateCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i += 1) {
        const idx = Math.floor(Math.random() * CODE_ALPHABET.length);
        code += CODE_ALPHABET[idx];
    }
    return code;
}
function toPublicSession(record) {
    return { ...record.session, viewerCount: record.viewerSocketIds.size };
}
/**
 * Owns all session state for the streaming server. Kept as a small,
 * dependency-free class so it can be unit tested without a real socket.
 */
export class RoomManager {
    roomsByCode = new Map();
    roomsById = new Map();
    createSession(hostSocketId, topic) {
        let code = generateCode();
        while (this.roomsByCode.has(code)) {
            code = generateCode();
        }
        const record = {
            session: {
                id: randomUUID(),
                code,
                hostId: hostSocketId,
                topic,
                state: "waiting",
                createdAt: Date.now(),
                viewerCount: 0,
            },
            hostSocketId,
            viewerSocketIds: new Set(),
        };
        this.roomsByCode.set(code, record);
        this.roomsById.set(record.session.id, record);
        return toPublicSession(record);
    }
    joinSession(code, viewerSocketId) {
        const record = this.roomsByCode.get(code.toUpperCase());
        if (!record || record.session.state === "ended") {
            return undefined;
        }
        record.viewerSocketIds.add(viewerSocketId);
        return toPublicSession(record);
    }
    updateSession(sessionId, hostSocketId, patch) {
        const record = this.roomsById.get(sessionId);
        if (!record || record.hostSocketId !== hostSocketId) {
            return undefined;
        }
        record.session = { ...record.session, ...patch };
        return toPublicSession(record);
    }
    leaveSession(sessionId, socketId) {
        const record = this.roomsById.get(sessionId);
        if (!record) {
            return undefined;
        }
        record.viewerSocketIds.delete(socketId);
        return toPublicSession(record);
    }
    /** Ends and removes any session hosted by this socket (e.g. on disconnect). */
    endSessionByHost(hostSocketId) {
        for (const record of this.roomsById.values()) {
            if (record.hostSocketId === hostSocketId) {
                record.session = { ...record.session, state: "ended" };
                const publicSession = toPublicSession(record);
                this.roomsByCode.delete(record.session.code);
                this.roomsById.delete(record.session.id);
                return publicSession;
            }
        }
        return undefined;
    }
    getSessionById(sessionId) {
        const record = this.roomsById.get(sessionId);
        return record ? toPublicSession(record) : undefined;
    }
}
//# sourceMappingURL=roomManager.js.map