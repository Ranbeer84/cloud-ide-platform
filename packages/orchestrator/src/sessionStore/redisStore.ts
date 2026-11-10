import { Redis } from "ioredis";
import type { SessionRecord } from "./sessionStore.js";
import {
  ApiError,
  hashToSessionRecord,
  sessionRecordToHash,
  type Logger,
  type OrchestratorSessionStore,
} from "./sessionTypes.js";

/**
 * Atomically bumps `updatedAt` on an existing session hash. Never creates a
 * key (so a heartbeat racing a DELETE cannot resurrect the session) and never
 * moves the timestamp backwards.
 * Returns 1 if the session exists, 0 otherwise.
 */
const TOUCH_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'updatedAt')
if not current then
  return 0
end
if tonumber(ARGV[1]) > (tonumber(current) or 0) then
  redis.call('HSET', KEYS[1], 'updatedAt', ARGV[1])
end
return 1
`;

export interface RedisSessionStoreOptions {
  /** Prefix for every key, e.g. "live:". */
  readonly keyPrefix: string;
  readonly logger: Logger;
}

/**
 * Creates the ioredis client used by the orchestrator.
 *
 * The client is lazy: nothing connects until `connect()` is awaited at boot,
 * which rejects if Redis is unreachable, so the process exits with a clear
 * error instead of serving requests it cannot persist. After a successful
 * connection, ioredis reconnects forever with a capped backoff, so a Redis
 * restart does not require restarting the orchestrator.
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  let connectedOnce = false;

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt: number): number | null => {
      // Never connected: give up so boot fails fast. Connected before: retry forever.
      if (!connectedOnce && attempt > 10) {
        return null;
      }
      return Math.min(attempt * 200, 2_000);
    },
  });

  client.on("ready", () => {
    connectedOnce = true;
    logger.info("redis.ready");
  });
  client.on("error", (error: Error) => {
    logger.warn("redis.error", { message: error.message });
  });
  client.on("close", () => {
    logger.warn("redis.connection_closed");
  });

  return client;
}

/**
 * Redis implementation of the Phase 1 SessionStore contract.
 *
 * Layout (all keys under `keyPrefix`):
 * - `session:<id>`  hash holding one SessionRecord (see sessionRecordToHash)
 * - `sessions`      set of every session id, so list() never needs SCAN/KEYS
 *
 * Writes touch both keys in one MULTI so the index never disagrees with the
 * hashes for longer than a crash window, and list() self-heals anything that
 * does drift (index entry without a hash, or an unreadable hash).
 */
export class RedisSessionStore implements OrchestratorSessionStore {
  private readonly redis: Redis;
  private readonly indexKey: string;
  private readonly keyPrefix: string;
  private readonly logger: Logger;

  constructor(redis: Redis, options: RedisSessionStoreOptions) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix;
    this.indexKey = `${options.keyPrefix}sessions`;
    this.logger = options.logger;
  }

  private sessionKey(sessionId: string): string {
    return `${this.keyPrefix}session:${sessionId}`;
  }

  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("redis.operation_failed", { operation, message });
      throw new ApiError(503, "store_unavailable", "Session store is unavailable");
    }
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.run("get", async () => {
      const hash = await this.redis.hgetall(this.sessionKey(sessionId));
      if (Object.keys(hash).length === 0) {
        return undefined;
      }
      const record = hashToSessionRecord(hash);
      if (!record) {
        this.logger.warn("redis.unreadable_record", { sessionId });
      }
      return record;
    });
  }

  async set(sessionId: string, record: SessionRecord): Promise<void> {
    if (record.sessionId !== sessionId) {
      throw new Error(`SessionRecord.sessionId (${record.sessionId}) does not match key ${sessionId}`);
    }
    await this.run("set", async () => {
      const results = await this.redis
        .multi()
        .hset(this.sessionKey(sessionId), { ...sessionRecordToHash(record) })
        .sadd(this.indexKey, sessionId)
        .exec();
      assertTransactionSucceeded(results);
    });
  }

  async delete(sessionId: string): Promise<void> {
    await this.run("delete", async () => {
      const results = await this.redis
        .multi()
        .del(this.sessionKey(sessionId))
        .srem(this.indexKey, sessionId)
        .exec();
      assertTransactionSucceeded(results);
    });
  }

  async list(): Promise<readonly SessionRecord[]> {
    return this.run("list", async () => {
      const ids = await this.redis.smembers(this.indexKey);
      if (ids.length === 0) {
        return [];
      }

      const pipeline = this.redis.pipeline();
      for (const id of ids) {
        pipeline.hgetall(this.sessionKey(id));
      }
      const results = await pipeline.exec();
      if (!results) {
        throw new Error("pipeline returned no results");
      }

      const records: SessionRecord[] = [];
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        const entry = results[index];
        if (id === undefined || entry === undefined) {
          continue;
        }
        const [error, value] = entry;
        if (error) {
          throw error;
        }

        const hash = (value ?? {}) as Record<string, string>;
        if (Object.keys(hash).length === 0) {
          // Index entry whose hash is gone: drop the dangling index entry.
          this.logger.warn("redis.dangling_index_entry", { sessionId: id });
          await this.redis.srem(this.indexKey, id);
          continue;
        }

        const record = hashToSessionRecord(hash);
        if (!record || record.sessionId !== id) {
          // Unreadable (corrupt or other schema version): remove it so it
          // cannot wedge the reaper/reconciler on every pass.
          this.logger.warn("redis.removing_unreadable_record", { sessionId: id });
          await this.redis.multi().del(this.sessionKey(id)).srem(this.indexKey, id).exec();
          continue;
        }

        records.push(record);
      }

      return records.sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  async touch(sessionId: string, at: number): Promise<boolean> {
    return this.run("touch", async () => {
      const result = await this.redis.eval(TOUCH_SCRIPT, 1, this.sessionKey(sessionId), String(at));
      return Number(result) === 1;
    });
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}

function assertTransactionSucceeded(results: [Error | null, unknown][] | null): void {
  if (!results) {
    throw new Error("Redis transaction was aborted");
  }
  for (const [error] of results) {
    if (error) {
      throw error;
    }
  }
}