import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "./api/routes.js";
import { Authenticator } from "./auth/authMiddleware.js";
import { loadConfig, type OrchestratorConfig } from "./config.js";
import { GvisorManager } from "./containers/gvisorManager.js";
import { HistoryRecordingSessionStore, loadPostgresOptions, PostgresDatabase } from "./db/postgres.js";
import { IdleReaper } from "./idleReaper.js";
import { reconcile, type ReconcileReport } from "./reconciler.js";
import { createRedisClient, RedisSessionStore } from "./sessionStore/redisStore.js";
import type { ApiContext, LogFields, Logger, OrchestratorSessionStore } from "./sessionStore/sessionTypes.js";

// ---- Public library surface (imported by phase verification scripts) ----
export { DockerManager } from "./containers/dockerManager.js";
export {
  GvisorManager,
  SANDBOX_RUNTIME,
  SANDBOX_NETWORK_PREFIX,
  SANDBOX_BRIDGE_PREFIX,
  sessionNetworkName,
  sessionBridgeName,
} from "./containers/gvisorManager.js";
export type { GvisorManagerOptions } from "./containers/gvisorManager.js";
export {
  Authenticator,
  TokenService,
  hashPassword,
  verifyPassword,
  parseAuthUsers,
  requireOwnedSession,
  loadOwnedSession,
  ANONYMOUS_PRINCIPAL,
} from "./auth/authMiddleware.js";
export type { AuthUser, Principal, LoginResult, AuthSettings } from "./auth/authMiddleware.js";
export type {
  ContainerResourceLimits,
  ContainerLabels,
  SpawnContainerOptions,
  ManagedContainerStatus,
  ManagedContainer,
  ContainerInspection,
  ExecResult,
  StopContainerOptions,
} from "./containers/containerTypes.js";

export type { SessionStore, SessionRecord } from "./sessionStore/sessionStore.js";
export { MemorySessionStore } from "./sessionStore/memoryStore.js";
export { RedisSessionStore, createRedisClient } from "./sessionStore/redisStore.js";
export { SESSION_SCHEMA_VERSION, ORPHAN_OWNER_ID } from "./sessionStore/sessionTypes.js";
export type {
  ApiContext,
  CreateSessionResponse,
  EndSessionResponse,
  Logger,
  OrchestratorSessionStore,
  SessionView,
} from "./sessionStore/sessionTypes.js";
export { PostgresDatabase, HistoryRecordingSessionStore, loadPostgresOptions } from "./db/postgres.js";
export type {
  Account,
  AccountSummary,
  AuditEntry,
  AuditEntryInput,
  AuditQuery,
  OwnerSessionStats,
  PostgresOptions,
  SessionHistoryEntry,
  SessionHistoryQuery,
} from "./db/postgres.js";
export { loadConfig, ConfigError } from "./config.js";
export type { OrchestratorConfig } from "./config.js";
export { reconcile } from "./reconciler.js";
export type { ReconcileReport } from "./reconciler.js";
export { IdleReaper } from "./idleReaper.js";
export { createRequestHandler } from "./api/routes.js";

// ---- Control plane entrypoint ----

/** One JSON object per line on stdout/stderr. Phase 9 swaps in a richer logger. */
export function createJsonLogger(): Logger {
  const write = (level: "info" | "warn" | "error", message: string, fields?: LogFields): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...(fields ?? {}) });
    if (level === "info") {
      process.stdout.write(`${line}\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

export interface RunningOrchestrator {
  readonly config: OrchestratorConfig;
  readonly server: Server;
  readonly reconcileReport: ReconcileReport;
  /** Undefined when DATABASE_URL is not set. */
  readonly database: PostgresDatabase | undefined;
  stop(): Promise<void>;
}

const DEFAULT_RECONCILE_GRACE_MS = 60_000;
/**
 * How long a stopping replica lets in-flight requests finish before it cuts
 * them off. Must exceed SANDBOX_READY_TIMEOUT_MS (a POST /api/sessions can
 * legitimately take that long), or a rolling restart would abort a session
 * that is half created.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

function readShutdownGraceMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["SHUTDOWN_GRACE_MS"]?.trim();
  if (!raw) {
    return DEFAULT_SHUTDOWN_GRACE_MS;
  }
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || parsed < 100 || parsed > 600_000) {
    throw new Error(`SHUTDOWN_GRACE_MS must be an integer between 100 and 600000 (got "${raw}")`);
  }
  return parsed;
}

function readGraceMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["RECONCILE_GRACE_MS"]?.trim();
  if (!raw) {
    return DEFAULT_RECONCILE_GRACE_MS;
  }
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || parsed > 3_600_000) {
    throw new Error(`RECONCILE_GRACE_MS must be an integer between 0 and 3600000 (got "${raw}")`);
  }
  return parsed;
}

/**
 * Boot sequence (order is deliberate):
 *  1. parse config                 - fail fast on bad env (including auth settings)
 *  2. require the gVisor runtime   - refuse to run sandboxes any other way
 *  3. connect to Redis             - fail fast if unreachable
 *  3b. connect to Postgres         - only when DATABASE_URL is set; migrate, sync accounts
 *  4. reconcile Redis vs Docker    - heal crash drift BEFORE serving traffic
 *  5. prune orphaned networks      - per-session networks left behind by a crash
 *  6. start the HTTP API
 *  7. start the idle reaper
 *
 * Several replicas can run this at once against the same Redis, Postgres and
 * Docker host. Step 4 is the delicate one: another replica may be in the
 * middle of POST /api/sessions, with a container started but its record not
 * yet written. That container looks exactly like an orphan, so containers
 * younger than RECONCILE_GRACE_MS (default 60 s, longer than the sandbox
 * readiness timeout) that have no record are left alone by this boot's
 * reconcile and network prune. Orphans that are still there after the grace
 * period are handled by the next boot or an operator, never by guesswork.
 */
export async function startOrchestrator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  logger: Logger = createJsonLogger(),
): Promise<RunningOrchestrator> {
  const config = loadConfig(env);
  const shutdownGraceMs = readShutdownGraceMs(env);
  const now = (): number => Date.now();

  const docker = new GvisorManager({ traefikContainer: config.traefikContainer, logger });
  await docker.assertRunscAvailable();

  const auth = new Authenticator({
    settings:
      config.authMode === "required"
        ? {
            mode: "required",
            secret: config.authSecret,
            users: config.authUsers,
            tokenTtlMs: config.authTokenTtlMs,
          }
        : { mode: "disabled" },
    logger,
    now,
  });
  if (!auth.enabled) {
    logger.warn("auth.disabled", {
      message: "ORCHESTRATOR_AUTH_MODE=disabled: every caller shares one anonymous account. Development on loopback only.",
    });
  }

  const redis = createRedisClient(config.redisUrl, logger);
  await redis.connect();

  const redisStore = new RedisSessionStore(redis, { keyPrefix: config.redisKeyPrefix, logger });

  let database: PostgresDatabase | undefined;
  let store: OrchestratorSessionStore = redisStore;
  let reconcileReport: ReconcileReport;
  try {
    const graceMs = readGraceMs(env);

    const databaseOptions = loadPostgresOptions(env, logger);
    if (databaseOptions) {
      database = await PostgresDatabase.connect(databaseOptions);
      await database.migrate();
      const synced = await database.syncAccounts(config.authUsers);
      logger.info("postgres.accounts_synced", { accounts: synced });
      store = new HistoryRecordingSessionStore(redisStore, database, logger, now);
    }

    // Containers that are too young to be judged are hidden from the
    // reconciler unless a record already claims them (see the boot sequence).
    const recordedContainerIds = new Set((await store.list()).map((record) => record.containerId));
    const youngUnrecorded = new Set<string>();
    const reconcilerDocker = {
      stopContainer: docker.stopContainer.bind(docker),
      async listManagedContainers() {
        const all = await docker.listManagedContainers();
        return all.filter((container) => {
          const young = graceMs > 0 && now() - container.createdAt < graceMs;
          if (young && !recordedContainerIds.has(container.containerId)) {
            youngUnrecorded.add(container.sessionId);
            return false;
          }
          return true;
        });
      },
    };

    reconcileReport = await reconcile({ store, docker: reconcilerDocker, logger, now, orphanPolicy: config.orphanPolicy });
    if (youngUnrecorded.size > 0) {
      logger.info("reconciler.skipped_young_containers", { sessionIds: [...youngUnrecorded], graceMs });
    }
    const activeSessionIds = new Set((await store.list()).map((record) => record.sessionId));
    for (const sessionId of youngUnrecorded) {
      activeSessionIds.add(sessionId);
    }
    const removedNetworks = await docker.pruneOrphanNetworks(activeSessionIds);
    if (removedNetworks.length > 0) {
      logger.warn("network.pruned_orphans", { networks: removedNetworks });
    }
  } catch (error) {
    redis.disconnect();
    await database?.close().catch(() => undefined);
    throw error;
  }

  const ctx: ApiContext = { config, store, docker, auth, logger, now };
  const server = createServer(createRequestHandler(ctx));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const reaper = new IdleReaper({
    store,
    docker,
    logger,
    now,
    idleTimeoutMs: config.idleTimeoutMs,
    intervalMs: config.idleReaperIntervalMs,
  });
  reaper.start();

  logger.info("orchestrator.listening", {
    host: config.host,
    port: config.port,
    hostSuffix: config.hostSuffix,
    orphanPolicy: config.orphanPolicy,
    authMode: config.authMode,
    runtime: "runsc",
    replicaId: env["REPLICA_ID"]?.trim() || "orchestrator",
    database: database !== undefined,
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await reaper.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), shutdownGraceMs).unref();
      });
      await redis.quit().catch(() => redis.disconnect());
      await database?.close().catch(() => undefined);
      logger.info("orchestrator.stopped");
    })();
    return stopping;
  };

  return { config, server, reconcileReport, database, stop };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const logger = createJsonLogger();
  try {
    const running = await startOrchestrator(process.env, logger);

    const shutdown = (signal: string): void => {
      logger.info("orchestrator.shutdown", { signal });
      running
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    logger.error("orchestrator.startup_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Only start the server when this file is executed directly
// (`node dist/index.js`), never when imported as a library by the Phase 1/2
// verification scripts.
if (isMainModule()) {
  void main();
}