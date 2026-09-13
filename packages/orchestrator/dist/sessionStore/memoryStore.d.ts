import type { SessionRecord, SessionStore } from "./sessionStore.js";
/**
 * In-memory SessionStore. Suitable for a single orchestrator process.
 *
 * Deliberately implements the exact same async SessionStore contract a
 * Phase 5 Redis-backed store will use (e.g. `redis.get`/`redis.set` behind
 * these same method names), so swapping the implementation later is a
 * one-line change at the construction site, not a refactor of callers.
 */
export declare class MemorySessionStore implements SessionStore {
    private readonly records;
    get(sessionId: string): Promise<SessionRecord | undefined>;
    set(sessionId: string, record: SessionRecord): Promise<void>;
    delete(sessionId: string): Promise<void>;
    list(): Promise<readonly SessionRecord[]>;
}
//# sourceMappingURL=memoryStore.d.ts.map