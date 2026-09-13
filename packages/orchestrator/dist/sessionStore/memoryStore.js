/**
 * In-memory SessionStore. Suitable for a single orchestrator process.
 *
 * Deliberately implements the exact same async SessionStore contract a
 * Phase 5 Redis-backed store will use (e.g. `redis.get`/`redis.set` behind
 * these same method names), so swapping the implementation later is a
 * one-line change at the construction site, not a refactor of callers.
 */
export class MemorySessionStore {
    records = new Map();
    async get(sessionId) {
        return this.records.get(sessionId);
    }
    async set(sessionId, record) {
        this.records.set(sessionId, record);
    }
    async delete(sessionId) {
        this.records.delete(sessionId);
    }
    async list() {
        return Array.from(this.records.values());
    }
}
//# sourceMappingURL=memoryStore.js.map