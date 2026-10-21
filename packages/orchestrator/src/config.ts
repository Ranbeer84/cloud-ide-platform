import { getHostSuffixFromEnv } from "./containers/proxyLabels.js";

/** Thrown with every problem found, so one run fixes all of them. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid orchestrator configuration:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export type OrphanPolicy = "kill" | "adopt";

export interface OrchestratorConfig {
  /** Interface the API listens on. Loopback by default (no auth until Phase 7). */
  readonly host: string;
  readonly port: number;

  readonly redisUrl: string;
  /** Prefix for every Redis key this orchestrator owns. */
  readonly redisKeyPrefix: string;

  readonly sandboxImage: string;
  /** Port the sandbox-agent listens on inside the container. */
  readonly sandboxAgentPort: number;
  /** Host name used to reach published sandbox-agent ports. */
  readonly sandboxAgentHost: string;
  readonly sandboxMemoryBytes: number;
  readonly sandboxNanoCpus: number;
  readonly sandboxPidsLimit: number;
  /** How long POST /api/sessions waits for the sandbox-agent to answer /health. */
  readonly sandboxReadyTimeoutMs: number;

  readonly maxSessions: number;
  /** A session with no heartbeat for this long is terminated. */
  readonly idleTimeoutMs: number;
  readonly idleReaperIntervalMs: number;

  /**
   * What the boot-time reconciler does with a running managed container that
   * has no Redis record: "kill" removes it, "adopt" re-creates the record.
   */
  readonly orphanPolicy: OrphanPolicy;

  /** Base URL of the web UI; used to build hostUrl / viewerUrl. */
  readonly webBaseUrl: string;
  /** Browser origin allowed by CORS ("*" allows any). */
  readonly allowedOrigin: string;

  /** Routing suffix, e.g. ".localhost" or ".sessions.yourdomain.dev". */
  readonly hostSuffix: string;
  /** https whenever hostSuffix is a real domain (matches proxyLabels' TLS default). */
  readonly previewScheme: "http" | "https";
}

type Env = Readonly<Record<string, string | undefined>>;

function readString(env: Env, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  return raw ? raw : fallback;
}

function readInt(
  env: Env,
  problems: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) {
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

function readNumber(
  env: Env,
  problems: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(`${name} must be a number (got "${raw}")`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    problems.push(`${name} must be between ${min} and ${max} (got ${parsed})`);
    return fallback;
  }
  return parsed;
}

function readUrl(env: Env, problems: string[], name: string, fallback: string, protocols: readonly string[]): string {
  const raw = readString(env, name, fallback);
  try {
    const parsed = new URL(raw);
    if (!protocols.includes(parsed.protocol)) {
      problems.push(`${name} must use one of ${protocols.join(", ")} (got "${raw}")`);
    }
  } catch {
    problems.push(`${name} must be a valid URL (got "${raw}")`);
  }
  return raw;
}

/**
 * Parses and validates the orchestrator's environment.
 *
 * | Variable                  | Default                   |
 * |---------------------------|---------------------------|
 * | ORCHESTRATOR_HOST         | 127.0.0.1                 |
 * | ORCHESTRATOR_PORT         | 4100                      |
 * | REDIS_URL                 | redis://127.0.0.1:6379    |
 * | REDIS_KEY_PREFIX          | live:                     |
 * | SANDBOX_IMAGE             | live/sandbox-base:latest  |
 * | SANDBOX_AGENT_PORT        | 7777                      |
 * | SANDBOX_AGENT_HOST        | 127.0.0.1                 |
 * | SANDBOX_MEMORY_MB         | 512                       |
 * | SANDBOX_CPUS              | 1                         |
 * | SANDBOX_PIDS_LIMIT        | 256                       |
 * | SANDBOX_READY_TIMEOUT_MS  | 20000                     |
 * | MAX_SESSIONS              | 50                        |
 * | SESSION_IDLE_TIMEOUT_MS   | 1800000 (30 min)          |
 * | IDLE_REAPER_INTERVAL_MS   | 30000                     |
 * | RECONCILER_ORPHAN_POLICY  | kill  (kill | adopt)      |
 * | WEB_BASE_URL              | http://localhost:5173     |
 * | ALLOWED_ORIGIN            | (same as WEB_BASE_URL)    |
 * | SESSION_HOST_SUFFIX       | .localhost                |
 */
export function loadConfig(env: Env = process.env): OrchestratorConfig {
  const problems: string[] = [];

  const host = readString(env, "ORCHESTRATOR_HOST", "127.0.0.1");
  const port = readInt(env, problems, "ORCHESTRATOR_PORT", 4100, 1, 65535);

  const redisUrl = readUrl(env, problems, "REDIS_URL", "redis://127.0.0.1:6379", ["redis:", "rediss:"]);
  const redisKeyPrefix = readString(env, "REDIS_KEY_PREFIX", "live:");

  const sandboxImage = readString(env, "SANDBOX_IMAGE", "live/sandbox-base:latest");
  const sandboxAgentPort = readInt(env, problems, "SANDBOX_AGENT_PORT", 7777, 1, 65535);
  const sandboxAgentHost = readString(env, "SANDBOX_AGENT_HOST", "127.0.0.1");
  const sandboxMemoryMb = readInt(env, problems, "SANDBOX_MEMORY_MB", 512, 64, 65536);
  const sandboxCpus = readNumber(env, problems, "SANDBOX_CPUS", 1, 0.1, 64);
  const sandboxPidsLimit = readInt(env, problems, "SANDBOX_PIDS_LIMIT", 256, 16, 65536);
  const sandboxReadyTimeoutMs = readInt(env, problems, "SANDBOX_READY_TIMEOUT_MS", 20_000, 1_000, 300_000);

  const maxSessions = readInt(env, problems, "MAX_SESSIONS", 50, 1, 10_000);
  const idleTimeoutMs = readInt(env, problems, "SESSION_IDLE_TIMEOUT_MS", 30 * 60 * 1000, 1_000, 7 * 24 * 3_600_000);
  const idleReaperIntervalMs = readInt(env, problems, "IDLE_REAPER_INTERVAL_MS", 30_000, 250, 3_600_000);

  const orphanPolicyRaw = readString(env, "RECONCILER_ORPHAN_POLICY", "kill");
  let orphanPolicy: OrphanPolicy = "kill";
  if (orphanPolicyRaw === "kill" || orphanPolicyRaw === "adopt") {
    orphanPolicy = orphanPolicyRaw;
  } else {
    problems.push(`RECONCILER_ORPHAN_POLICY must be "kill" or "adopt" (got "${orphanPolicyRaw}")`);
  }

  const webBaseUrl = readUrl(env, problems, "WEB_BASE_URL", "http://localhost:5173", ["http:", "https:"]).replace(
    /\/+$/,
    "",
  );
  const allowedOrigin = readString(env, "ALLOWED_ORIGIN", webBaseUrl);

  const hostSuffix = getHostSuffixFromEnv(env);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    host,
    port,
    redisUrl,
    redisKeyPrefix,
    sandboxImage,
    sandboxAgentPort,
    sandboxAgentHost,
    sandboxMemoryBytes: sandboxMemoryMb * 1024 * 1024,
    sandboxNanoCpus: Math.round(sandboxCpus * 1_000_000_000),
    sandboxPidsLimit,
    sandboxReadyTimeoutMs,
    maxSessions,
    idleTimeoutMs,
    idleReaperIntervalMs,
    orphanPolicy,
    webBaseUrl,
    allowedOrigin,
    hostSuffix,
    previewScheme: hostSuffix === ".localhost" ? "http" : "https",
  };
}