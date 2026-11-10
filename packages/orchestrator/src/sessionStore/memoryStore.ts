import type { SessionRecord, SessionStore } from "./sessionStore.js";

/**
 * In-memory SessionStore. Suitable for a single orchestrator process.
 *
 * Deliberately implements the exact same async SessionStore contract a
 * Phase 5 Redis-backed store will use (e.g. `redis.get`/`redis.set` behind
 * these same method names), so swapping the implementation later is a
 * one-line change at the construction site, not a refactor of callers.
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.records.get(sessionId);
  }

  async set(sessionId: string, record: SessionRecord): Promise<void> {
    this.records.set(sessionId, record);
  }

  async delete(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }

  async list(): Promise<readonly SessionRecord[]> {
    return Array.from(this.records.values());
  }
}
