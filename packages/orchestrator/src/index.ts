import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "./api/routes.js";
import { Authenticator } from "./auth/authMiddleware.js";
import { loadConfig, type OrchestratorConfig } from "./config.js";
import { GvisorManager } from "./containers/gvisorManager.js";
import { IdleReaper } from "./idleReaper.js";
import { reconcile, type ReconcileReport } from "./reconciler.js";
import { createRedisClient, RedisSessionStore } from "./sessionStore/redisStore.js";
import type { ApiContext, LogFields, Logger } from "./sessionStore/sessionTypes.js";

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
  stop(): Promise<void>;
}

/**
 * Boot sequence (order is deliberate):
 *  1. parse config                 - fail fast on bad env (including auth settings)
 *  2. require the gVisor runtime   - refuse to run sandboxes any other way
 *  3. connect to Redis             - fail fast if unreachable
 *  4. reconcile Redis vs Docker    - heal crash drift BEFORE serving traffic
 *  5. prune orphaned networks      - per-session networks left behind by a crash
 *  6. start the HTTP API
 *  7. start the idle reaper
 */
export async function startOrchestrator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  logger: Logger = createJsonLogger(),
): Promise<RunningOrchestrator> {
  const config = loadConfig(env);
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

  const store = new RedisSessionStore(redis, { keyPrefix: config.redisKeyPrefix, logger });

  let reconcileReport: ReconcileReport;
  try {
    reconcileReport = await reconcile({ store, docker, logger, now, orphanPolicy: config.orphanPolicy });
    const activeSessionIds = new Set((await store.list()).map((record) => record.sessionId));
    const removedNetworks = await docker.pruneOrphanNetworks(activeSessionIds);
    if (removedNetworks.length > 0) {
      logger.warn("network.pruned_orphans", { networks: removedNetworks });
    }
  } catch (error) {
    redis.disconnect();
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
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await reaper.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 2_000).unref();
      });
      await redis.quit().catch(() => redis.disconnect());
      logger.info("orchestrator.stopped");
    })();
    return stopping;
  };

  return { config, server, reconcileReport, stop };
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