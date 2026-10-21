import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "./api/routes.js";
import { loadConfig, type OrchestratorConfig } from "./config.js";
import { DockerManager } from "./containers/dockerManager.js";
import { IdleReaper } from "./idleReaper.js";
import { reconcile, type ReconcileReport } from "./reconciler.js";
import { createRedisClient, RedisSessionStore } from "./sessionStore/redisStore.js";
import type { ApiContext, LogFields, Logger } from "./sessionStore/sessionTypes.js";

// ---- Public library surface (imported by phase verification scripts) ----
export { DockerManager } from "./containers/dockerManager.js";
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
 *  1. parse config                 - fail fast on bad env
 *  2. connect to Redis             - fail fast if unreachable
 *  3. reconcile Redis vs Docker    - heal crash drift BEFORE serving traffic
 *  4. start the HTTP API
 *  5. start the idle reaper
 */
export async function startOrchestrator(
  env: Readonly<Record<string, string | undefined>> = process.env,
  logger: Logger = createJsonLogger(),
): Promise<RunningOrchestrator> {
  const config = loadConfig(env);

  const redis = createRedisClient(config.redisUrl, logger);
  await redis.connect();

  const store = new RedisSessionStore(redis, { keyPrefix: config.redisKeyPrefix, logger });
  const docker = new DockerManager();
  const now = (): number => Date.now();

  let reconcileReport: ReconcileReport;
  try {
    reconcileReport = await reconcile({ store, docker, logger, now, orphanPolicy: config.orphanPolicy });
  } catch (error) {
    redis.disconnect();
    throw error;
  }

  const ctx: ApiContext = { config, store, docker, logger, now };
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