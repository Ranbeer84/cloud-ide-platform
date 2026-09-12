import type { Session, SessionUpdatableFields } from "@live/shared-types";
import { randomUUID } from "node:crypto";

interface RoomRecord {
  session: Session;
  hostSocketId: string;
  viewerSocketIds: Set<string>;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const CODE_LENGTH = 6;

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const idx = Math.floor(Math.random() * CODE_ALPHABET.length);
    code += CODE_ALPHABET[idx];
  }
  return code;
}

function toPublicSession(record: RoomRecord): Session {
  return { ...record.session, viewerCount: record.viewerSocketIds.size };
}

/**
 * Owns all session state for the streaming server. Kept as a small,
 * dependency-free class so it can be unit tested without a real socket.
 */
export class RoomManager {
  private readonly roomsByCode = new Map<string, RoomRecord>();
  private readonly roomsById = new Map<string, RoomRecord>();

  createSession(hostSocketId: string, topic: string): Session {
    let code = generateCode();
    while (this.roomsByCode.has(code)) {
      code = generateCode();
    }

    const record: RoomRecord = {
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
      viewerSocketIds: new Set<string>(),
    };

    this.roomsByCode.set(code, record);
    this.roomsById.set(record.session.id, record);
    return toPublicSession(record);
  }

  joinSession(code: string, viewerSocketId: string): Session | undefined {
    const record = this.roomsByCode.get(code.toUpperCase());
    if (!record || record.session.state === "ended") {
      return undefined;
    }
    record.viewerSocketIds.add(viewerSocketId);
    return toPublicSession(record);
  }

  updateSession(
    sessionId: string,
    hostSocketId: string,
    patch: Partial<SessionUpdatableFields>,
  ): Session | undefined {
    const record = this.roomsById.get(sessionId);
    if (!record || record.hostSocketId !== hostSocketId) {
      return undefined;
    }
    record.session = { ...record.session, ...patch };
    return toPublicSession(record);
  }

  leaveSession(sessionId: string, socketId: string): Session | undefined {
    const record = this.roomsById.get(sessionId);
    if (!record) {
      return undefined;
    }
    record.viewerSocketIds.delete(socketId);
    return toPublicSession(record);
  }

  /** Ends and removes any session hosted by this socket (e.g. on disconnect). */
  endSessionByHost(hostSocketId: string): Session | undefined {
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

  getSessionById(sessionId: string): Session | undefined {
    const record = this.roomsById.get(sessionId);
    return record ? toPublicSession(record) : undefined;
  }
}
