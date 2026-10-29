import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AuthUser } from "../auth/authMiddleware.js";
import type { ManagedContainerStatus } from "../containers/containerTypes.js";
import type { SessionRecord } from "../sessionStore/sessionStore.js";
import type { Logger, OrchestratorSessionStore } from "../sessionStore/sessionTypes.js";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface PostgresOptions {
  readonly connectionString: string;
  /** Name of this orchestrator replica, written into history and audit rows. */
  readonly replicaId: string;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly logger: Logger;
}

type Env = Readonly<Record<string, string | undefined>>;

function readBoundedInt(env: Env, problems: string[], name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be an integer (got "${raw}")`);
    return fallback;
  }
  const parsed = Number(raw);
  if (parsed < min || parsed > max) {
    problems.push(`${name} must be between ${min} and ${max} (got ${parsed})`);
    return fallback;
  }
  return parsed;
}

/**
 * Reads the database settings from the environment.
 *
 * | Variable                   | Default            |
 * |----------------------------|--------------------|
 * | DATABASE_URL               | (unset = no DB)    |
 * | REPLICA_ID                 | orchestrator       |
 * | POSTGRES_POOL_MAX          | 10                 |
 * | POSTGRES_CONNECT_TIMEOUT_MS| 5000               |
 * | POSTGRES_IDLE_TIMEOUT_MS   | 30000              |
 * | POSTGRES_STATEMENT_TIMEOUT_MS | 10000           |
 *
 * Returns undefined when DATABASE_URL is not set, which keeps the
 * orchestrator in its Phase 5-7 shape (Redis only) so the earlier phases'
 * verification scripts run unchanged. Throws one Error listing every problem.
 */
export function loadPostgresOptions(env: Env, logger: Logger): PostgresOptions | undefined {
  const connectionString = env["DATABASE_URL"]?.trim() ?? "";
  if (connectionString.length === 0) {
    return undefined;
  }

  const problems: string[] = [];
  try {
    const parsed = new URL(connectionString);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      problems.push(`DATABASE_URL must use postgres:// or postgresql:// (got "${parsed.protocol}//")`);
    }
  } catch {
    problems.push("DATABASE_URL must be a valid URL");
  }

  const poolMax = readBoundedInt(env, problems, "POSTGRES_POOL_MAX", 10, 1, 200);
  const connectTimeoutMs = readBoundedInt(env, problems, "POSTGRES_CONNECT_TIMEOUT_MS", 5_000, 100, 120_000);
  const idleTimeoutMs = readBoundedInt(env, problems, "POSTGRES_IDLE_TIMEOUT_MS", 30_000, 1_000, 3_600_000);
  const statementTimeoutMs = readBoundedInt(env, problems, "POSTGRES_STATEMENT_TIMEOUT_MS", 10_000, 100, 600_000);
  const replicaId = env["REPLICA_ID"]?.trim() || "orchestrator";

  if (problems.length > 0) {
    throw new Error(`Invalid database configuration:\n - ${problems.join("\n - ")}`);
  }
  return { connectionString, replicaId, poolMax, connectTimeoutMs, idleTimeoutMs, statementTimeoutMs, logger };
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * Arbitrary constant naming the migration lock. Two replicas booting at the
 * same moment would otherwise both run CREATE TABLE IF NOT EXISTS, which can
 * still fail with a duplicate-type error: IF NOT EXISTS is not race-free.
 */
const MIGRATION_LOCK_ID = 7_243_001;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Append-only. A migration that has been applied to any database is never
 * edited; changes go into a new version. Every statement is also written to
 * be safe to re-run (IF NOT EXISTS), as a second line of defence.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "accounts, session history, audit log",
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        disabled      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_key ON accounts (lower(username));

      CREATE TABLE IF NOT EXISTS session_history (
        session_id       TEXT PRIMARY KEY,
        owner_id         TEXT NOT NULL,
        container_id     TEXT NOT NULL,
        image            TEXT NOT NULL,
        host_agent_port  INTEGER NOT NULL,
        status           TEXT NOT NULL,
        started_at       TIMESTAMPTZ NOT NULL,
        last_activity_at TIMESTAMPTZ NOT NULL,
        ended_at         TIMESTAMPTZ,
        end_reason       TEXT,
        start_replica    TEXT NOT NULL,
        end_replica      TEXT,
        CONSTRAINT session_history_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
      );
      CREATE INDEX IF NOT EXISTS session_history_owner_idx ON session_history (owner_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS session_history_started_idx ON session_history (started_at DESC);
      CREATE INDEX IF NOT EXISTS session_history_active_idx ON session_history (started_at) WHERE ended_at IS NULL;

      CREATE TABLE IF NOT EXISTS audit_log (
        id         BIGSERIAL PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        replica_id TEXT NOT NULL,
        event      TEXT NOT NULL,
        actor_id   TEXT,
        session_id TEXT,
        detail     JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
      CREATE INDEX IF NOT EXISTS audit_log_session_idx ON audit_log (session_id, at DESC) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, at DESC) WHERE actor_id IS NOT NULL;
    `,
  },
];

/* ------------------------------------------------------------------ */
/* Row shapes returned to callers                                      */
/* ------------------------------------------------------------------ */

export interface Account {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly disabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastLoginAt: number | null;
}

/** An account without its password hash, safe to list and return from an API. */
export type AccountSummary = Omit<Account, "passwordHash">;

export interface SessionHistoryEntry {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly containerId: string;
  readonly image: string;
  readonly hostAgentPort: number;
  readonly status: ManagedContainerStatus;
  readonly startedAt: number;
  /** Last heartbeat the session had when it ended; while it is running, the last value seen at start. */
  readonly lastActivityAt: number;
  readonly endedAt: number | null;
  readonly endReason: string | null;
  /** endedAt - startedAt in milliseconds, or null while the session is still running. */
  readonly durationMs: number | null;
  readonly startReplica: string;
  readonly endReplica: string | null;
}

export interface SessionHistoryQuery {
  readonly ownerId?: string | undefined;
  /** true: only running sessions; false: only finished ones; undefined: both. */
  readonly active?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface OwnerSessionStats {
  readonly ownerId: string;
  readonly totalSessions: number;
  readonly activeSessions: number;
  readonly totalDurationMs: number;
  readonly lastStartedAt: number | null;
}

export interface AuditEntryInput {
  readonly event: string;
  readonly actorId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
  /** Defaults to the database's clock. */
  readonly at?: number | undefined;
}

export interface AuditEntry {
  readonly id: number;
  readonly at: number;
  readonly replicaId: string;
  readonly event: string;
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface AuditQuery {
  readonly sessionId?: string | undefined;
  readonly actorId?: string | undefined;
  readonly event?: string | undefined;
  readonly limit?: number | undefined;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;
const CONNECT_ATTEMPTS = 10;

/** Milliseconds since the epoch, read back from a timestamptz column. */
const EPOCH_MS = (column: string): string => `(extract(epoch from ${column}) * 1000)::float8`;

function toMs(value: unknown): number {
  return Math.round(Number(value));
}

function toMsOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toMs(value);
}

function clampPage(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface AccountRow extends QueryResultRow {
  id: string;
  username: string;
  password_hash: string;
  disabled: boolean;
  created_ms: number;
  updated_ms: number;
  last_login_ms: number | null;
}

const ACCOUNT_COLUMNS = `
  id, username, password_hash, disabled,
  ${EPOCH_MS("created_at")} AS created_ms,
  ${EPOCH_MS("updated_at")} AS updated_ms,
  ${EPOCH_MS("last_login_at")} AS last_login_ms
`;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    disabled: row.disabled,
    createdAt: toMs(row.created_ms),
    updatedAt: toMs(row.updated_ms),
    lastLoginAt: toMsOrNull(row.last_login_ms),
  };
}

interface HistoryRow extends QueryResultRow {
  session_id: string;
  owner_id: string;
  container_id: string;
  image: string;
  host_agent_port: number;
  status: string;
  started_ms: number;
  activity_ms: number;
  ended_ms: number | null;
  end_reason: string | null;
  duration_ms: number | null;
  start_replica: string;
  end_replica: string | null;
}

const HISTORY_COLUMNS = `
  session_id, owner_id, container_id, image, host_agent_port, status,
  ${EPOCH_MS("started_at")} AS started_ms,
  ${EPOCH_MS("last_activity_at")} AS activity_ms,
  ${EPOCH_MS("ended_at")} AS ended_ms,
  end_reason,
  CASE WHEN ended_at IS NULL THEN NULL
       ELSE (extract(epoch from (ended_at - started_at)) * 1000)::float8 END AS duration_ms,
  start_replica, end_replica
`;

function toHistoryEntry(row: HistoryRow): SessionHistoryEntry {
  return {
    sessionId: row.session_id,
    ownerId: row.owner_id,
    containerId: row.container_id,
    image: row.image,
    hostAgentPort: row.host_agent_port,
    status: row.status as ManagedContainerStatus,
    startedAt: toMs(row.started_ms),
    lastActivityAt: toMs(row.activity_ms),
    endedAt: toMsOrNull(row.ended_ms),
    endReason: row.end_reason,
    durationMs: toMsOrNull(row.duration_ms),
    startReplica: row.start_replica,
    endReplica: row.end_replica,
  };
}

interface AuditRow extends QueryResultRow {
  id: string;
  at_ms: number;
  replica_id: string;
  event: string;
  actor_id: string | null;
  session_id: string | null;
  detail: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

/**
 * PostgreSQL access for the orchestrator: user accounts, durable session
 * history, and an audit log.
 *
 * Redis stays the source of truth for LIVE sessions (it is what the API, the
 * idle reaper and the reconciler read). Postgres is the durable record of
 * what happened: it keeps a session's start, end and owner after Redis has
 * forgotten it, and it is shared by every orchestrator replica.
 */
export class PostgresDatabase {
  private readonly pool: Pool;
  private readonly options: PostgresOptions;

  private constructor(pool: Pool, options: PostgresOptions) {
    this.pool = pool;
    this.options = options;
  }

  /**
   * Opens the pool and proves the database answers. Retries for a few seconds
   * so a Postgres container that is still starting does not fail the boot;
   * after that it throws, so the process exits with a clear error.
   */
  static async connect(options: PostgresOptions): Promise<PostgresDatabase> {
    const pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolMax,
      idleTimeoutMillis: options.idleTimeoutMs,
      connectionTimeoutMillis: options.connectTimeoutMs,
      statement_timeout: options.statementTimeoutMs,
      application_name: `live-${options.replicaId}`,
    });
    // An idle client that errors (database restart) must not crash the process.
    pool.on("error", (error: Error) => {
      options.logger.warn("postgres.pool_error", { message: error.message });
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await pool.query("SELECT 1");
        options.logger.info("postgres.ready", { attempt });
        return new PostgresDatabase(pool, options);
      } catch (error) {
        lastError = error;
        options.logger.warn("postgres.connect_retry", { attempt, message: describeError(error) });
        await sleep(Math.min(attempt * 300, 2_000));
      }
    }
    await pool.end().catch(() => undefined);
    throw new Error(`Could not connect to Postgres after ${CONNECT_ATTEMPTS} attempts: ${describeError(lastError)}`);
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.options.logger.info("postgres.closed");
  }

  /* ---------------------------- schema ---------------------------- */

  /**
   * Creates or upgrades the schema. Idempotent and safe to run from several
   * replicas at once: the whole thing runs in one transaction holding a
   * transaction-scoped advisory lock, so a second replica waits, then finds
   * every migration already recorded and does nothing.
   * Returns the versions applied by THIS call (empty when already up to date).
   */
  async migrate(): Promise<readonly number[]> {
    const client = await this.pool.connect();
    const applied: number[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const done = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
      const doneVersions = new Set(done.rows.map((row) => row.version));

      for (const migration of MIGRATIONS) {
        if (doneVersions.has(migration.version)) {
          continue;
        }
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          migration.version,
          migration.name,
        ]);
        applied.push(migration.version);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    this.options.logger.info("postgres.migrated", { applied, latest: MIGRATIONS[MIGRATIONS.length - 1]?.version });
    return applied;
  }

  /* --------------------------- accounts --------------------------- */

  /**
   * Makes the accounts table match the configured users (the
   * ORCHESTRATOR_AUTH_USERS list): inserts new ones, updates changed
   * usernames and password hashes. It never deletes and never re-enables a
   * disabled account. Rows are written in id order so replicas syncing at
   * the same moment cannot deadlock.
   */
  async syncAccounts(users: readonly AuthUser[]): Promise<number> {
    if (users.length === 0) {
      return 0;
    }
    const ordered = [...users].sort((a, b) => a.id.localeCompare(b.id));
    await this.inTransaction(async (client) => {
      for (const user of ordered) {
        await client.query(
          `INSERT INTO accounts (id, username, password_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE
             SET username = EXCLUDED.username,
                 password_hash = EXCLUDED.password_hash,
                 updated_at = now()
             WHERE accounts.username IS DISTINCT FROM EXCLUDED.username
                OR accounts.password_hash IS DISTINCT FROM EXCLUDED.password_hash`,
          [user.id, user.username, user.passwordHash],
        );
      }
    });
    return ordered.length;
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const result = await this.pool.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? toAccount(row) : undefined;
  }

  async findAccountByUsername(username: string): Promise<Account | undefined> {
    const result = await this.pool.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE lower(username) = lower($1)`,
      [username],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : undefined;
  }

  async listAccounts(): Promise<readonly AccountSummary[]> {
    const result = await this.pool.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at, id`);
    return result.rows.map((row) => {
      const { passwordHash: _passwordHash, ...summary } = toAccount(row);
      return summary;
    });
  }

  /** Stamps a successful sign-in. Returns false if there is no such account. */
  async recordLogin(userId: string, atMs: number): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE accounts SET last_login_at = to_timestamp($2::float8 / 1000.0) WHERE id = $1",
      [userId, atMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Returns false if there is no such account. */
  async setAccountDisabled(userId: string, disabled: boolean): Promise<boolean> {
    const result = await this.pool.query("UPDATE accounts SET disabled = $2, updated_at = now() WHERE id = $1", [
      userId,
      disabled,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /* ----------------------- session history ----------------------- */

  /**
   * Records that a session started. Calling it again for the same session
   * (the reconciler rewrites records, and two replicas can both see a
   * create) refreshes status and port but never moves the start time or
   * re-opens a session that already ended.
   */
  async recordSessionStarted(record: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_history
         (session_id, owner_id, container_id, image, host_agent_port, status,
          started_at, last_activity_at, start_replica)
       VALUES ($1, $2, $3, $4, $5, $6,
               to_timestamp($7::float8 / 1000.0), to_timestamp($8::float8 / 1000.0), $9)
       ON CONFLICT (session_id) DO UPDATE
         SET status = EXCLUDED.status,
             host_agent_port = EXCLUDED.host_agent_port,
             last_activity_at = GREATEST(session_history.last_activity_at, EXCLUDED.last_activity_at)
         WHERE session_history.ended_at IS NULL`,
      [
        record.sessionId,
        record.ownerId,
        record.containerId,
        record.image,
        record.hostAgentPort,
        record.status,
        record.createdAt,
        record.updatedAt,
        this.options.replicaId,
      ],
    );
  }

  /**
   * Records that a session ended. Idempotent: the first call wins, so two
   * replicas tearing down the same session (the reaper on one, a DELETE on
   * the other) leave one consistent row. If the session was never recorded
   * as started (it began before history was enabled, or Postgres was down
   * at the time) a complete row is created from `record`.
   */
  async recordSessionEnded(record: SessionRecord, reason: string, endedAtMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_history
         (session_id, owner_id, container_id, image, host_agent_port, status,
          started_at, last_activity_at, ended_at, end_reason, start_replica, end_replica)
       VALUES ($1, $2, $3, $4, $5, $6,
               to_timestamp($7::float8 / 1000.0), to_timestamp($8::float8 / 1000.0),
               GREATEST(to_timestamp($9::float8 / 1000.0), to_timestamp($7::float8 / 1000.0)),
               $10, $11, $11)
       ON CONFLICT (session_id) DO UPDATE
         SET ended_at = GREATEST(EXCLUDED.ended_at, session_history.started_at),
             end_reason = EXCLUDED.end_reason,
             end_replica = EXCLUDED.end_replica,
             last_activity_at = GREATEST(session_history.last_activity_at, EXCLUDED.last_activity_at)
         WHERE session_history.ended_at IS NULL`,
      [
        record.sessionId,
        record.ownerId,
        record.containerId,
        record.image,
        record.hostAgentPort,
        record.status,
        record.createdAt,
        record.updatedAt,
        endedAtMs,
        reason,
        this.options.replicaId,
      ],
    );
  }

  async getSessionHistory(sessionId: string): Promise<SessionHistoryEntry | undefined> {
    const result = await this.pool.query<HistoryRow>(
      `SELECT ${HISTORY_COLUMNS} FROM session_history WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row ? toHistoryEntry(row) : undefined;
  }

  /** Newest first. `limit` is capped at 500. */
  async listSessionHistory(query: SessionHistoryQuery = {}): Promise<readonly SessionHistoryEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.ownerId !== undefined) {
      values.push(query.ownerId);
      conditions.push(`owner_id = $${values.length}`);
    }
    if (query.active === true) {
      conditions.push("ended_at IS NULL");
    } else if (query.active === false) {
      conditions.push("ended_at IS NOT NULL");
    }
    const limit = clampPage(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = clampPage(query.offset, 0, Number.MAX_SAFE_INTEGER);
    values.push(limit, offset);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<HistoryRow>(
      `SELECT ${HISTORY_COLUMNS} FROM session_history ${where}
       ORDER BY started_at DESC, session_id
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map(toHistoryEntry);
  }

  async getOwnerStats(ownerId: string): Promise<OwnerSessionStats> {
    const result = await this.pool.query<{
      total: number;
      active: number;
      total_duration_ms: number;
      last_started_ms: number | null;
    }>(
      `SELECT count(*)::int AS total,
              (count(*) FILTER (WHERE ended_at IS NULL))::int AS active,
              COALESCE(sum(extract(epoch from (ended_at - started_at)) * 1000)
                       FILTER (WHERE ended_at IS NOT NULL), 0)::float8 AS total_duration_ms,
              ${EPOCH_MS("max(started_at)")} AS last_started_ms
       FROM session_history WHERE owner_id = $1`,
      [ownerId],
    );
    const row = result.rows[0];
    return {
      ownerId,
      totalSessions: row?.total ?? 0,
      activeSessions: row?.active ?? 0,
      totalDurationMs: row ? toMs(row.total_duration_ms) : 0,
      lastStartedAt: row ? toMsOrNull(row.last_started_ms) : null,
    };
  }

  /* ---------------------------- audit ---------------------------- */

  async recordAudit(entry: AuditEntryInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (at, replica_id, event, actor_id, session_id, detail)
       VALUES (COALESCE(to_timestamp($1::float8 / 1000.0), now()), $2, $3, $4, $5, $6::jsonb)`,
      [
        entry.at ?? null,
        this.options.replicaId,
        entry.event,
        entry.actorId ?? null,
        entry.sessionId ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  }

  /** Newest first. `limit` is capped at 500. */
  async listAudit(query: AuditQuery = {}): Promise<readonly AuditEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.sessionId !== undefined) {
      values.push(query.sessionId);
      conditions.push(`session_id = $${values.length}`);
    }
    if (query.actorId !== undefined) {
      values.push(query.actorId);
      conditions.push(`actor_id = $${values.length}`);
    }
    if (query.event !== undefined) {
      values.push(query.event);
      conditions.push(`event = $${values.length}`);
    }
    values.push(clampPage(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<AuditRow>(
      `SELECT id::text AS id, ${EPOCH_MS("at")} AS at_ms, replica_id, event, actor_id, session_id, detail
       FROM audit_log ${where}
       ORDER BY at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      at: toMs(row.at_ms),
      replicaId: row.replica_id,
      event: row.event,
      actorId: row.actor_id,
      sessionId: row.session_id,
      detail: row.detail,
    }));
  }

  /* --------------------------- internals --------------------------- */

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Session store decorator                                             */
/* ------------------------------------------------------------------ */

/** The slice of PostgresDatabase the decorator writes to. */
export type SessionHistoryWriter = Pick<PostgresDatabase, "recordSessionStarted" | "recordSessionEnded" | "recordAudit">;

/**
 * Wraps the Redis session store and mirrors its lifecycle into Postgres, so
 * session history is captured at the one place every create and every
 * teardown already goes through (POST, DELETE, the idle reaper and the boot
 * reconciler), without changing any of them.
 *
 *  - `set` of a new session  -> session_history row + "session.started" audit event
 *  - `delete`                -> the row gets ended_at, owner, duration and an
 *                               "session.ended" audit event
 *
 * Redis remains authoritative: every read and write goes to it first and its
 * result is what callers get. A Postgres failure is logged and skipped, never
 * thrown, because a database outage must not stop people from starting or
 * ending sandboxes. The cost is that history for that window is lost;
 * `postgres.history_write_failed` in the logs says exactly which sessions.
 *
 * The end reason is a generic "ended": the store's delete() is not told why a
 * session is being removed. Callers that know can call
 * `PostgresDatabase.recordSessionEnded` with a specific reason first.
 */
export class HistoryRecordingSessionStore implements OrchestratorSessionStore {
  private readonly inner: OrchestratorSessionStore;
  private readonly history: SessionHistoryWriter;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(inner: OrchestratorSessionStore, history: SessionHistoryWriter, logger: Logger, now: () => number) {
    this.inner = inner;
    this.history = history;
    this.logger = logger;
    this.now = now;
  }

  get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.inner.get(sessionId);
  }

  list(): Promise<readonly SessionRecord[]> {
    return this.inner.list();
  }

  touch(sessionId: string, at: number): Promise<boolean> {
    return this.inner.touch(sessionId, at);
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }

  async set(sessionId: string, record: SessionRecord): Promise<void> {
    await this.inner.set(sessionId, record);
    await this.bestEffort("start", sessionId, async () => {
      await this.history.recordSessionStarted(record);
      await this.history.recordAudit({
        event: "session.started",
        actorId: record.ownerId,
        sessionId,
        detail: { containerId: record.containerId, image: record.image },
        at: this.now(),
      });
    });
  }

  async delete(sessionId: string): Promise<void> {
    // Read first: after the delete the owner and timestamps are gone from Redis.
    const record = await this.inner.get(sessionId);
    await this.inner.delete(sessionId);
    if (!record) {
      return;
    }
    const endedAt = this.now();
    await this.bestEffort("end", sessionId, async () => {
      await this.history.recordSessionEnded(record, "ended", endedAt);
      await this.history.recordAudit({
        event: "session.ended",
        actorId: record.ownerId,
        sessionId,
        detail: { containerId: record.containerId, lastActivityAt: record.updatedAt },
        at: endedAt,
      });
    });
  }

  private async bestEffort(phase: "start" | "end", sessionId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn("postgres.history_write_failed", { phase, sessionId, message: describeError(error) });
    }
  }
}