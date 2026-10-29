import type { Authenticator } from "../auth/authMiddleware.js";
import type { DockerManager } from "../containers/dockerManager.js";
import type { ManagedContainerStatus } from "../containers/containerTypes.js";
import { sanitizeSubdomain } from "../containers/proxyLabels.js";
import type { OrchestratorConfig } from "../config.js";
import type { SessionRecord, SessionStore } from "./sessionStore.js";

/**
 * Bumped whenever the persisted Redis hash layout changes. Records written
 * with a different version are treated as unreadable and cleaned up by the
 * store / reconciler rather than being half-interpreted.
 *
 * Version history:
 *   1  Phase 5: sessionId, containerId, image, hostAgentPort, status,
 *      createdAt, updatedAt.
 *   2  Phase 7: adds `ownerId`.
 *
 * MIGRATION NOTE (1 -> 2). There is deliberately no in-place upgrade. A v1
 * record has no owner, and guessing one would hand somebody else's sandbox to
 * the wrong account. Sessions are short-lived (idle reaping after 30 minutes
 * by default), so the safe migration is to drain:
 *   - Deploy this version. On first read, every v1 record is unreadable, so
 *     the store deletes it (see RedisSessionStore.get/list).
 *   - The container behind a deleted v1 record is now an orphan. The boot
 *     reconciler removes it under the default RECONCILER_ORPHAN_POLICY=kill.
 *     Under "adopt" it is re-registered with ORPHAN_OWNER_ID, which no
 *     account can match, so it can only be reaped, never used.
 *   - Users lose their running sandboxes once, at deploy time. If that is not
 *     acceptable, wait for sessions to go idle (or end them) before deploying.
 * Rolling back to a v1 orchestrator makes v2 records unreadable in the same
 * way, so roll back the same way: drain first.
 */
export const SESSION_SCHEMA_VERSION = 2;

/**
 * Owner given to sessions the reconciler adopts, which have no known account.
 * Account ids may not contain ":" (see USER_ID_PATTERN in authMiddleware.ts),
 * so no login can ever equal this value.
 */
export const ORPHAN_OWNER_ID = "orphan:unclaimed";

/** Account ids plus the reserved orphan id. Used to validate persisted records. */
const OWNER_ID_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/;

const MANAGED_STATUSES: readonly ManagedContainerStatus[] = [
  "starting",
  "running",
  "stopped",
  "oom_killed",
  "exited",
  "error",
];

function isManagedStatus(value: string): value is ManagedContainerStatus {
  return (MANAGED_STATUSES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export type LogFields = Readonly<Record<string, unknown>>;

/** Minimal structured logger. Phase 9 replaces the implementation. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** An error that maps directly onto an HTTP status + machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Store contract                                                      */
/* ------------------------------------------------------------------ */

/**
 * The Phase 1 `SessionStore` contract plus the two operations a durable,
 * shared store needs that an in-memory map never did:
 *
 * - `touch`: an atomic "record activity" that can never resurrect a session
 *   that was deleted concurrently (unlike get -> modify -> set).
 * - `ping`: liveness of the backing store, for /healthz.
 */
export interface OrchestratorSessionStore extends SessionStore {
  /** Sets updatedAt (last activity) to `at`. Returns false if no such session. */
  touch(sessionId: string, at: number): Promise<boolean>;
  ping(): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* Redis serialization                                                 */
/* ------------------------------------------------------------------ */

/** Flat string map, the shape a Redis hash stores. */
export type SessionHash = Readonly<Record<string, string>>;

export function sessionRecordToHash(record: SessionRecord): SessionHash {
  return {
    schemaVersion: String(SESSION_SCHEMA_VERSION),
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    containerId: record.containerId,
    image: record.image,
    hostAgentPort: String(record.hostAgentPort),
    status: record.status,
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  };
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Validates and converts a Redis hash back into a SessionRecord.
 * Returns undefined for anything missing, malformed or from another schema
 * version (including every v1 record, which has no owner), so callers can
 * treat it as "no usable record".
 */
export function hashToSessionRecord(hash: SessionHash): SessionRecord | undefined {
  if (hash["schemaVersion"] !== String(SESSION_SCHEMA_VERSION)) {
    return undefined;
  }

  const sessionId = hash["sessionId"];
  const ownerId = hash["ownerId"];
  const containerId = hash["containerId"];
  const image = hash["image"];
  const status = hash["status"];
  const hostAgentPort = parseNonNegativeInt(hash["hostAgentPort"]);
  const createdAt = parseNonNegativeInt(hash["createdAt"]);
  const updatedAt = parseNonNegativeInt(hash["updatedAt"]);

  if (
    !sessionId ||
    !ownerId ||
    !OWNER_ID_PATTERN.test(ownerId) ||
    !containerId ||
    !image ||
    !status ||
    !isManagedStatus(status) ||
    hostAgentPort === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }

  return { sessionId, ownerId, containerId, image, hostAgentPort, status, createdAt, updatedAt };
}

/* ------------------------------------------------------------------ */
/* API shapes                                                          */
/* ------------------------------------------------------------------ */

/** The subset of DockerManager the API layer, reaper and reconciler use. */
export type SessionDocker = Pick<
  DockerManager,
  "spawnContainer" | "inspectContainer" | "stopContainer" | "listManagedContainers"
>;

/** Everything a request handler needs, injected so each piece is testable. */
export interface ApiContext {
  readonly config: OrchestratorConfig;
  readonly store: OrchestratorSessionStore;
  readonly docker: SessionDocker;
  /** Authenticates requests and issues tokens (Phase 7). */
  readonly auth: Authenticator;
  readonly logger: Logger;
  readonly now: () => number;
}

/** What the API returns for a session (create, get and list). */
export interface SessionView {
  readonly sessionId: string;
  /** Web UI page for the host of this session. */
  readonly hostUrl: string;
  /** Web UI page for viewers of this session. */
  readonly viewerUrl: string;
  /** Where a web server on port 8080 inside the sandbox is reachable (via Traefik). */
  readonly previewUrl: string;
  /**
   * Direct sandbox-agent URL (pty, file API). Published on the host's
   * loopback interface only (see GvisorManager). The agent has no
   * authentication of its own yet, so this must not be exposed beyond the
   * host until it is proxied behind the orchestrator's auth.
   */
  readonly agentUrl: string;
  readonly containerId: string;
  readonly status: ManagedContainerStatus;
  readonly createdAt: number;
  /** Last recorded activity (heartbeat). The idle reaper measures from here. */
  readonly lastActivityAt: number;
}

export type CreateSessionResponse = SessionView;

export interface EndSessionResponse {
  readonly sessionId: string;
  readonly ended: true;
}

export interface HeartbeatResponse {
  readonly sessionId: string;
  readonly lastActivityAt: number;
}

export function toSessionView(record: SessionRecord, config: OrchestratorConfig): SessionView {
  const encodedId = encodeURIComponent(record.sessionId);
  return {
    sessionId: record.sessionId,
    hostUrl: `${config.webBaseUrl}/host?session=${encodedId}`,
    viewerUrl: `${config.webBaseUrl}/viewer?session=${encodedId}`,
    previewUrl: `${config.previewScheme}://${sanitizeSubdomain(record.sessionId)}${config.hostSuffix}`,
    agentUrl: `http://${config.sandboxAgentHost}:${record.hostAgentPort}`,
    containerId: record.containerId,
    status: record.status,
    createdAt: record.createdAt,
    lastActivityAt: record.updatedAt,
  };
}