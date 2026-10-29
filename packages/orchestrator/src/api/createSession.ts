import { randomBytes } from "node:crypto";
import type { ManagedContainer } from "../containers/containerTypes.js";
import type { SessionRecord } from "../sessionStore/sessionStore.js";
import {
  ApiError,
  toSessionView,
  type ApiContext,
  type CreateSessionResponse,
} from "../sessionStore/sessionTypes.js";

const READY_POLL_INTERVAL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 1_000;
const ID_GENERATION_ATTEMPTS = 5;

/** 16 hex chars after an "s": a valid DNS label, unguessable enough for a dev control plane. */
function generateSessionId(): string {
  return `s${randomBytes(8).toString("hex")}`;
}

async function generateUniqueSessionId(ctx: ApiContext): Promise<string> {
  for (let attempt = 0; attempt < ID_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = generateSessionId();
    if (!(await ctx.store.get(candidate))) {
      return candidate;
    }
  }
  throw new ApiError(500, "id_generation_failed", "Could not allocate a unique session id");
}

/** Polls the sandbox-agent's /health until it answers 200 or the deadline passes. */
async function waitForAgentReady(
  ctx: ApiContext,
  hostAgentPort: number,
): Promise<boolean> {
  const url = `http://${ctx.config.sandboxAgentHost}:${hostAgentPort}/health`;
  const deadline = ctx.now() + ctx.config.sandboxReadyTimeoutMs;

  while (ctx.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) });
      if (response.ok) {
        return true;
      }
    } catch {
      // Not listening yet; keep polling until the deadline.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Best-effort removal of every container belonging to a session id. Used when
 * a spawn fails part-way, where dockerManager may have created a container
 * but never returned its id. Never throws; anything it misses is caught by the
 * boot-time reconciler.
 */
async function removeContainersForSession(ctx: ApiContext, sessionId: string): Promise<void> {
  try {
    const containers = await ctx.docker.listManagedContainers();
    for (const container of containers) {
      if (container.sessionId === sessionId) {
        await ctx.docker.stopContainer(container.containerId);
      }
    }
  } catch (error) {
    ctx.logger.warn("session.spawn_cleanup_failed", {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/sessions
 *
 * 1. Enforce the session cap.
 * 2. Spawn the sandbox container (dockerManager attaches the Traefik labels,
 *    so its route exists as soon as the container is running).
 * 3. Wait until the sandbox-agent actually answers, so a returned session is
 *    immediately usable.
 * 4. Only then persist the record. A crash before this point leaves an
 *    untracked container, which the boot-time reconciler removes; a failure
 *    inside this function removes it right away.
 */
export async function createSession(ctx: ApiContext, ownerId: string): Promise<CreateSessionResponse> {
  const existing = await ctx.store.list();
  if (existing.length >= ctx.config.maxSessions) {
    throw new ApiError(
      429,
      "capacity_reached",
      `Session limit reached (${ctx.config.maxSessions}); end a session and try again`,
    );
  }
  const ownedCount = existing.filter((record) => record.ownerId === ownerId).length;
  if (ownedCount >= ctx.config.maxSessionsPerUser) {
    throw new ApiError(
      429,
      "user_capacity_reached",
      `You already have ${ownedCount} sessions (limit ${ctx.config.maxSessionsPerUser}); end one and try again`,
    );
  }

  const sessionId = await generateUniqueSessionId(ctx);

  let container: ManagedContainer;
  try {
    container = await ctx.docker.spawnContainer({
      image: ctx.config.sandboxImage,
      sessionId,
      agentPort: ctx.config.sandboxAgentPort,
      resourceLimits: {
        memoryBytes: ctx.config.sandboxMemoryBytes,
        nanoCpus: ctx.config.sandboxNanoCpus,
        pidsLimit: ctx.config.sandboxPidsLimit,
      },
      env: { PORT: String(ctx.config.sandboxAgentPort) },
    });
  } catch (error) {
    ctx.logger.error("session.spawn_failed", {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    await removeContainersForSession(ctx, sessionId);
    throw new ApiError(502, "spawn_failed", "Failed to start the sandbox container");
  }

  const ready = await waitForAgentReady(ctx, container.hostAgentPort);
  if (!ready) {
    ctx.logger.error("session.agent_not_ready", { sessionId, containerId: container.containerId });
    await ctx.docker.stopContainer(container.containerId).catch(() => undefined);
    throw new ApiError(504, "sandbox_not_ready", "The sandbox did not become ready in time");
  }

  const now = ctx.now();
  const record: SessionRecord = {
    sessionId,
    containerId: container.containerId,
    image: container.image,
    hostAgentPort: container.hostAgentPort,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await ctx.store.set(sessionId, record);
  } catch (error) {
    await ctx.docker.stopContainer(container.containerId).catch(() => undefined);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, "store_unavailable", "Session store is unavailable");
  }

  ctx.logger.info("session.created", {
    sessionId,
    containerId: container.containerId,
    hostAgentPort: container.hostAgentPort,
  });

  return toSessionView(record, ctx.config);
}