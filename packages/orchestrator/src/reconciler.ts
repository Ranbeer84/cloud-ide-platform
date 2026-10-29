import type { ManagedContainer } from "./containers/containerTypes.js";
import type { OrphanPolicy } from "./config.js";
import type { SessionRecord } from "./sessionStore/sessionStore.js";
import { ORPHAN_OWNER_ID, type Logger, type OrchestratorSessionStore, type SessionDocker } from "./sessionStore/sessionTypes.js";

export interface ReconcilerDeps {
  readonly store: OrchestratorSessionStore;
  readonly docker: Pick<SessionDocker, "listManagedContainers" | "stopContainer">;
  readonly logger: Logger;
  readonly now: () => number;
  readonly orphanPolicy: OrphanPolicy;
}

export interface ReconcileProblem {
  readonly subject: string;
  readonly message: string;
}

export interface ReconcileReport {
  readonly recordsChecked: number;
  readonly containersChecked: number;
  /** Sessions whose record and running container agree; their idle clock was reset. */
  readonly keptSessions: readonly string[];
  /** Records whose container no longer exists: record deleted. */
  readonly removedStaleRecords: readonly string[];
  /** Records whose container exists but is not running: container removed, record deleted. */
  readonly removedDeadSessions: readonly string[];
  /** Running managed containers with no record, removed (policy "kill"). */
  readonly killedOrphans: readonly string[];
  /** Running managed containers with no record, re-registered (policy "adopt"). */
  readonly adoptedOrphans: readonly string[];
  /** Per-item failures. A failure never aborts the rest of the reconciliation. */
  readonly errors: readonly ReconcileProblem[];
}

const UNKNOWN_SESSION_ID = "unknown";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Boot-time reconciliation of Redis session records against the containers
 * Docker is actually running. Persisting to Redis alone is not crash
 * recovery: after a crash the two can disagree, and this is what heals them.
 *
 * For every record:
 * - container missing                 -> delete the stale record
 * - container present but not running -> remove the container, delete the record
 * - container running                 -> keep it; refresh its host port if Docker
 *                                        reports a different one, and reset its
 *                                        idle clock (the orchestrator being down
 *                                        must not count as the user being idle,
 *                                        or every session would be reaped on boot)
 *
 * For every managed container no surviving record claims (an orphan):
 * - policy "kill"  -> stop and remove it
 * - policy "adopt" -> re-create its record, if it is running, has a published
 *                     agent port and a real session id; otherwise kill it
 *
 * Must run BEFORE the API starts accepting requests, so a container being
 * spawned by a live request can never be mistaken for an orphan.
 * Throws only if the initial listing of records or containers fails.
 */
export async function reconcile(deps: ReconcilerDeps): Promise<ReconcileReport> {
  const { store, docker, logger, now, orphanPolicy } = deps;

  const records = await store.list();
  const containers = await docker.listManagedContainers();

  const containersById = new Map<string, ManagedContainer>();
  for (const container of containers) {
    containersById.set(container.containerId, container);
  }
  const recordedSessionIds = new Set(records.map((record) => record.sessionId));

  const keptSessions: string[] = [];
  const removedStaleRecords: string[] = [];
  const removedDeadSessions: string[] = [];
  const killedOrphans: string[] = [];
  const adoptedOrphans: string[] = [];
  const errors: ReconcileProblem[] = [];

  // Container ids that have been accounted for (kept, or removed with their record).
  const handledContainerIds = new Set<string>();

  for (const record of records) {
    try {
      const container = containersById.get(record.containerId);

      if (!container) {
        await store.delete(record.sessionId);
        removedStaleRecords.push(record.sessionId);
        logger.warn("reconciler.removed_stale_record", {
          sessionId: record.sessionId,
          containerId: record.containerId,
        });
        continue;
      }

      handledContainerIds.add(container.containerId);

      if (container.status !== "running") {
        await docker.stopContainer(container.containerId);
        await store.delete(record.sessionId);
        removedDeadSessions.push(record.sessionId);
        logger.warn("reconciler.removed_dead_session", {
          sessionId: record.sessionId,
          containerId: record.containerId,
        });
        continue;
      }

      const portChanged = container.hostAgentPort > 0 && container.hostAgentPort !== record.hostAgentPort;
      if (portChanged) {
        const refreshed: SessionRecord = {
          ...record,
          hostAgentPort: container.hostAgentPort,
          status: "running",
          updatedAt: now(),
        };
        await store.set(record.sessionId, refreshed);
      } else {
        await store.touch(record.sessionId, now());
      }
      keptSessions.push(record.sessionId);
    } catch (error) {
      errors.push({ subject: `record:${record.sessionId}`, message: describeError(error) });
      logger.error("reconciler.record_failed", {
        sessionId: record.sessionId,
        message: describeError(error),
      });
    }
  }

  for (const container of containers) {
    if (handledContainerIds.has(container.containerId)) {
      continue;
    }

    try {
      const canAdopt =
        orphanPolicy === "adopt" &&
        container.status === "running" &&
        container.hostAgentPort > 0 &&
        container.sessionId !== UNKNOWN_SESSION_ID &&
        // A record for this session id already points at a different
        // container, so this one is a duplicate, never the rightful owner.
        !recordedSessionIds.has(container.sessionId);

      if (canAdopt) {
        const timestamp = now();
        await store.set(container.sessionId, {
          sessionId: container.sessionId,
          // Nobody is known to own an adopted container. No account can equal
          // this id, so the session can be reaped but never used.
          ownerId: ORPHAN_OWNER_ID,
          containerId: container.containerId,
          image: container.image,
          hostAgentPort: container.hostAgentPort,
          status: "running",
          createdAt: container.createdAt,
          updatedAt: timestamp,
        });
        recordedSessionIds.add(container.sessionId);
        adoptedOrphans.push(container.sessionId);
        logger.warn("reconciler.adopted_orphan", {
          sessionId: container.sessionId,
          containerId: container.containerId,
        });
        continue;
      }

      await docker.stopContainer(container.containerId);
      killedOrphans.push(container.containerId);
      logger.warn("reconciler.killed_orphan", {
        sessionId: container.sessionId,
        containerId: container.containerId,
      });
    } catch (error) {
      errors.push({ subject: `container:${container.containerId}`, message: describeError(error) });
      logger.error("reconciler.container_failed", {
        containerId: container.containerId,
        message: describeError(error),
      });
    }
  }

  const report: ReconcileReport = {
    recordsChecked: records.length,
    containersChecked: containers.length,
    keptSessions,
    removedStaleRecords,
    removedDeadSessions,
    killedOrphans,
    adoptedOrphans,
    errors,
  };

  logger.info("reconciler complete", {
    recordsChecked: report.recordsChecked,
    containersChecked: report.containersChecked,
    kept: keptSessions.length,
    removedStaleRecords: removedStaleRecords.length,
    removedDeadSessions: removedDeadSessions.length,
    killedOrphans: killedOrphans.length,
    adoptedOrphans: adoptedOrphans.length,
    errors: errors.length,
  });

  return report;
}