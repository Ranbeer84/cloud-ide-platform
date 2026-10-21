import type { SessionRecord } from "../sessionStore/sessionStore.js";
import {
  ApiError,
  type ApiContext,
  type EndSessionResponse,
  type Logger,
  type OrchestratorSessionStore,
  type SessionDocker,
} from "../sessionStore/sessionTypes.js";

/** The slice of the world teardown needs (satisfied by ApiContext and by the idle reaper). */
export interface TerminationContext {
  readonly store: Pick<OrchestratorSessionStore, "delete">;
  readonly docker: Pick<SessionDocker, "stopContainer">;
  readonly logger: Logger;
}

/**
 * Tears a session down completely: container first, then its Redis state.
 *
 * Order matters for crash safety:
 * - Container stop/remove is idempotent (already stopped / already gone is
 *   fine), and Traefik's Docker provider drops the session's route the moment
 *   the container disappears, so removing the container IS the proxy-route
 *   cleanup.
 * - The Redis record is deleted only after the container is gone. If the
 *   process dies in between, the leftover record points at a missing
 *   container and the boot-time reconciler removes it. The reverse order
 *   would leave a running container nobody tracks.
 * - If stopping the container fails for any reason other than "already
 *   gone", this throws and the record is kept, so the teardown can be retried.
 */
export async function terminateSession(
  ctx: TerminationContext,
  record: SessionRecord,
  reason: string,
): Promise<void> {
  await ctx.docker.stopContainer(record.containerId);
  await ctx.store.delete(record.sessionId);
  ctx.logger.info("session.terminated", {
    sessionId: record.sessionId,
    containerId: record.containerId,
    reason,
  });
}

/** DELETE /api/sessions/:id */
export async function endSession(ctx: ApiContext, sessionId: string): Promise<EndSessionResponse> {
  const record = await ctx.store.get(sessionId);
  if (!record) {
    throw new ApiError(404, "session_not_found", `No session with id "${sessionId}"`);
  }

  await terminateSession(ctx, record, "api");
  return { sessionId, ended: true };
}