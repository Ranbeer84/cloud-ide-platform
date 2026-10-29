import type { ManagedContainerStatus } from "../containers/containerTypes.js";

/**
 * Persisted record linking a logical session to the container running it.
 * This is the unit of data SessionStore implementations store and retrieve.
 */
export interface SessionRecord {
  readonly sessionId: string;
  /**
   * Id of the account that owns this session (Phase 7). Only the owner may
   * read, heartbeat or end it. Immutable for the life of the session.
   */
  readonly ownerId: string;
  readonly containerId: string;
  readonly image: string;
  readonly hostAgentPort: number;
  readonly status: ManagedContainerStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Storage-agnostic contract for session bookkeeping.
 *
 * All methods are async even though the Phase 1 in-memory implementation
 * doesn't strictly need to be, so that a Phase 5 Redis-backed
 * implementation is a drop-in replacement with no call-site changes.
 */
export interface SessionStore {
  get(sessionId: string): Promise<SessionRecord | undefined>;
  set(sessionId: string, record: SessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<readonly SessionRecord[]>;
}