import { terminateSession } from "./api/endSession.js";
import type { Logger, OrchestratorSessionStore, SessionDocker } from "./sessionStore/sessionTypes.js";

export interface IdleReaperDeps {
  readonly store: OrchestratorSessionStore;
  readonly docker: Pick<SessionDocker, "inspectContainer" | "stopContainer">;
  readonly logger: Logger;
  readonly now: () => number;
  /** A session whose last activity is older than this is terminated. */
  readonly idleTimeoutMs: number;
  /** How often the background sweep runs. */
  readonly intervalMs: number;
}

export type ReapReason = "idle" | "container-not-running";

export interface ReapedSession {
  readonly sessionId: string;
  readonly reason: ReapReason;
}

export interface ReapResult {
  readonly checked: number;
  readonly reaped: readonly ReapedSession[];
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: number } | undefined)?.statusCode === 404;
}

/**
 * Background worker that ends sessions that are no longer worth keeping:
 *
 * - "idle": no heartbeat (POST /api/sessions/:id/heartbeat) for longer than
 *   idleTimeoutMs. "Last activity" is the record's `updatedAt`.
 * - "container-not-running": the container crashed, was OOM-killed or was
 *   removed behind the orchestrator's back while it was running. Without this
 *   a dead session would sit in Redis until its idle timeout.
 *
 * Termination goes through the same terminateSession() as DELETE, so the
 * container, its Traefik route and its Redis keys are all removed.
 */
export class IdleReaper {
  private readonly deps: IdleReaperDeps;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<ReapResult> | undefined;

  constructor(deps: IdleReaperDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.deps.logger.error("idle_reaper.sweep_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.deps.intervalMs);
    this.timer.unref();
    this.deps.logger.info("idle_reaper.started", {
      idleTimeoutMs: this.deps.idleTimeoutMs,
      intervalMs: this.deps.intervalMs,
    });
  }

  /** Stops scheduling and waits for a sweep that is already running. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /**
   * Runs one sweep. If a sweep is already running, returns that same sweep
   * rather than starting an overlapping one.
   */
  runOnce(): Promise<ReapResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const sweep = this.sweep().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = sweep;
    return sweep;
  }

  private async sweep(): Promise<ReapResult> {
    const { store, docker, logger, now, idleTimeoutMs } = this.deps;
    const records = await store.list();
    const reaped: ReapedSession[] = [];

    for (const record of records) {
      try {
        const idleForMs = now() - record.updatedAt;

        if (idleForMs > idleTimeoutMs) {
          await terminateSession({ store, docker, logger }, record, "idle");
          reaped.push({ sessionId: record.sessionId, reason: "idle" });
          continue;
        }

        let running = false;
        try {
          running = (await docker.inspectContainer(record.containerId)).running;
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }

        if (!running) {
          await terminateSession({ store, docker, logger }, record, "container-not-running");
          reaped.push({ sessionId: record.sessionId, reason: "container-not-running" });
        }
      } catch (error) {
        // One bad session must not stop the sweep; it is retried next pass.
        logger.error("idle_reaper.session_failed", {
          sessionId: record.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (reaped.length > 0) {
      logger.info("idle_reaper.sweep_complete", {
        checked: records.length,
        reaped: reaped.map((entry) => `${entry.sessionId}:${entry.reason}`),
      });
    }

    return { checked: records.length, reaped };
  }
}