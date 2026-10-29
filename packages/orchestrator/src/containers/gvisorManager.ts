import { createHash } from "node:crypto";
import Docker from "dockerode";
import type { ManagedContainer, SpawnContainerOptions, StopContainerOptions } from "./containerTypes.js";
import { DockerManager } from "./dockerManager.js";
import { computeProxyLabels, DEFAULT_PROXY_TARGET_PORT, getHostSuffixFromEnv } from "./proxyLabels.js";
import type { Logger } from "../sessionStore/sessionTypes.js";

/** The only container runtime sandboxes are allowed to run under. There is no fallback to runc. */
export const SANDBOX_RUNTIME = "runsc";

/** Name prefix of the per-session Docker networks. */
export const SANDBOX_NETWORK_PREFIX = "live-sbx-";

/**
 * Linux bridge interface names are capped at 15 characters, and the host
 * firewall (scripts/apply-sandbox-firewall.sh) matches every sandbox bridge
 * with this prefix, so it must stay in sync with that script.
 */
export const SANDBOX_BRIDGE_PREFIX = "lsbx";

const MANAGED_LABEL_KEY = "live.managed";
const SESSION_LABEL_KEY = "live.session-id";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const TRAEFIK_SERVICE_NAME = "traefik";

/** Docker network that holds one session's sandbox (and Traefik, so previews route). */
export function sessionNetworkName(sessionId: string): string {
  return `${SANDBOX_NETWORK_PREFIX}${sessionId}`;
}

/** Host-side bridge interface name for a session network: "lsbx" + 8 hex = 12 characters. */
export function sessionBridgeName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return `${SANDBOX_BRIDGE_PREFIX}${digest}`;
}

export interface GvisorManagerOptions {
  /** Running Traefik container to attach to every session network. Empty or unset auto-detects the compose service "traefik". */
  readonly traefikContainer?: string;
  /**
   * Host interface the sandbox-agent port is published on. Defaults to the
   * loopback interface so the unauthenticated agent is not reachable from the
   * network, or from other sandboxes through the bridge gateway.
   */
  readonly agentPublishIp?: string;
  readonly logger?: Logger;
}

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * DockerManager hardened for running untrusted code.
 *
 * What changes relative to DockerManager:
 *
 *  - Runtime. Every container is created with `Runtime: "runsc"` (gVisor):
 *    its syscalls are served by a user-space kernel instead of the host's.
 *    Creation fails if runsc is not registered with the Docker daemon, and
 *    the runtime is read back from the created container and checked; there
 *    is no fallback to runc. assertRunscAvailable() lets the orchestrator
 *    refuse to start on a host that has no runsc.
 *  - Network. Each session gets its own bridge network instead of the shared
 *    `live-network`, so sandboxes cannot reach one another. Traefik is
 *    attached to the session network so the preview route still works. The
 *    bridge has a recognizable name so the host firewall can block sandbox
 *    traffic to the host, to metadata endpoints and to private networks (see
 *    scripts/apply-sandbox-firewall.sh; Docker alone cannot).
 *  - Exposure. The agent port is published on the loopback interface only.
 *  - Privileges. All Linux capabilities are dropped and no-new-privileges is
 *    set, on top of the memory, CPU and pid limits DockerManager applies.
 */
export class GvisorManager extends DockerManager {
  private readonly engine: Docker;
  private readonly traefikContainer: string;
  private readonly agentPublishIp: string;
  private readonly logger: Logger | undefined;

  constructor(options: GvisorManagerOptions = {}, docker: Docker = new Docker()) {
    super(docker);
    this.engine = docker;
    this.traefikContainer = options.traefikContainer ?? "";
    this.agentPublishIp = options.agentPublishIp ?? "127.0.0.1";
    this.logger = options.logger;
  }

  /** Throws unless the Docker daemon has the gVisor runtime registered. */
  async assertRunscAvailable(): Promise<void> {
    const info = (await this.engine.info()) as { Runtimes?: Record<string, unknown> };
    const runtimes = Object.keys(info.Runtimes ?? {});
    if (!runtimes.includes(SANDBOX_RUNTIME)) {
      throw new Error(
        `Docker runtime "${SANDBOX_RUNTIME}" (gVisor) is not registered (found: ${runtimes.join(", ") || "none"}). ` +
          "Sandboxes only run under gVisor. Install runsc and add it to the Docker daemon's \"runtimes\" " +
          "(https://gvisor.dev/docs/user_guide/install/), then restart Docker.",
      );
    }
  }

  override async spawnContainer(options: SpawnContainerOptions): Promise<ManagedContainer> {
    const networkName = sessionNetworkName(options.sessionId);
    await this.createSessionNetwork(options.sessionId, networkName);

    let containerId: string | undefined;
    try {
      const labels: Record<string, string> = {
        // Caller labels first, so they can never overwrite routing or bookkeeping labels.
        ...(options.labels ?? {}),
        ...computeProxyLabels(options.sessionId, {
          targetPort: DEFAULT_PROXY_TARGET_PORT,
          network: networkName,
          hostSuffix: getHostSuffixFromEnv(),
        }),
        [MANAGED_LABEL_KEY]: "true",
        [SESSION_LABEL_KEY]: options.sessionId,
      };

      const containerPort = `${options.agentPort}/tcp`;
      const env = options.env
        ? Object.entries(options.env).map(([key, value]) => `${key}=${value}`)
        : undefined;

      const container = await this.engine.createContainer({
        Image: options.image,
        Labels: labels,
        Env: env,
        ExposedPorts: { [containerPort]: {} },
        HostConfig: {
          Runtime: SANDBOX_RUNTIME,
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Memory: options.resourceLimits.memoryBytes,
          MemorySwap: options.resourceLimits.memorySwapBytes ?? options.resourceLimits.memoryBytes,
          NanoCpus: options.resourceLimits.nanoCpus,
          PidsLimit: options.resourceLimits.pidsLimit,
          PortBindings: { [containerPort]: [{ HostIp: this.agentPublishIp, HostPort: "0" }] },
          RestartPolicy: { Name: "no" },
          NetworkMode: networkName,
        },
        NetworkingConfig: { EndpointsConfig: { [networkName]: {} } },
        Tty: false,
      });
      containerId = container.id;

      await container.start();

      const inspected = await container.inspect();
      const runtime = (inspected.HostConfig as { Runtime?: string }).Runtime;
      if (runtime !== SANDBOX_RUNTIME) {
        throw new Error(`Container ${container.id} is running under "${runtime ?? "unknown"}", not "${SANDBOX_RUNTIME}"`);
      }
      const hostPort = inspected.NetworkSettings.Ports[containerPort]?.[0]?.HostPort;
      if (!hostPort) {
        throw new Error(`Container ${container.id} did not publish expected port ${containerPort}`);
      }

      await this.attachTraefik(networkName);

      return {
        containerId: container.id,
        sessionId: options.sessionId,
        image: options.image,
        hostAgentPort: Number(hostPort),
        labels,
        createdAt: Date.now(),
        status: "running",
      };
    } catch (error) {
      if (containerId !== undefined) {
        await super.stopContainer(containerId, { timeoutSeconds: 1 }).catch(() => undefined);
      }
      await this.removeSessionNetworks(options.sessionId);
      throw error;
    }
  }

  override async stopContainer(containerId: string, options: StopContainerOptions = {}): Promise<void> {
    let sessionId: string | undefined;
    try {
      const inspected = await this.engine.getContainer(containerId).inspect();
      sessionId = inspected.Config.Labels?.[SESSION_LABEL_KEY];
    } catch (error) {
      if (statusCodeOf(error) !== 404) {
        throw error;
      }
    }

    await super.stopContainer(containerId, options);

    if (sessionId !== undefined) {
      await this.removeSessionNetworks(sessionId);
    }
  }

  /**
   * Removes session networks that no longer have a sandbox in them, for
   * sessions not in `activeSessionIds`. Run once at boot, after the
   * reconciler, to clean up after a crash. Returns the names removed.
   */
  async pruneOrphanNetworks(activeSessionIds: ReadonlySet<string>): Promise<readonly string[]> {
    const networks = await this.engine.listNetworks({ filters: { label: [`${MANAGED_LABEL_KEY}=true`] } });
    const traefikId = await this.findTraefikContainerId();
    const removed: string[] = [];

    for (const summary of networks) {
      const sessionId = summary.Labels?.[SESSION_LABEL_KEY];
      if (sessionId === undefined || activeSessionIds.has(sessionId)) {
        continue;
      }
      try {
        const details = await this.engine.getNetwork(summary.Id).inspect();
        const attached = Object.keys((details.Containers ?? {}) as Record<string, unknown>);
        if (attached.some((id) => id !== traefikId)) {
          continue; // a sandbox is still using it; the reconciler owns that container
        }
        await this.removeNetwork(summary.Id, attached);
        removed.push(summary.Name);
      } catch (error) {
        this.logger?.warn("network.prune_failed", { network: summary.Name, message: messageOf(error) });
      }
    }
    return removed;
  }

  private async createSessionNetwork(sessionId: string, networkName: string): Promise<void> {
    try {
      await this.engine.createNetwork({
        Name: networkName,
        Driver: "bridge",
        CheckDuplicate: true,
        Internal: false,
        EnableIPv6: false,
        Labels: { [MANAGED_LABEL_KEY]: "true", [SESSION_LABEL_KEY]: sessionId },
        Options: { "com.docker.network.bridge.name": sessionBridgeName(sessionId) },
      });
    } catch (error) {
      if (!messageOf(error).includes("already exists")) {
        throw error;
      }
    }
  }

  private async findTraefikContainerId(): Promise<string | undefined> {
    try {
      if (this.traefikContainer.length > 0) {
        return (await this.engine.getContainer(this.traefikContainer).inspect()).Id;
      }
      const found = await this.engine.listContainers({
        filters: { label: [`${COMPOSE_SERVICE_LABEL}=${TRAEFIK_SERVICE_NAME}`], status: ["running"] },
      });
      return found[0]?.Id;
    } catch {
      return undefined;
    }
  }

  /** Joins Traefik to a session network so its route to the sandbox works. */
  private async attachTraefik(networkName: string): Promise<void> {
    const traefikId = await this.findTraefikContainerId();
    if (traefikId === undefined) {
      this.logger?.warn("network.traefik_not_found", {
        network: networkName,
        hint: "Set TRAEFIK_CONTAINER, or run Traefik through docker compose as the service \"traefik\". The preview URL will not route.",
      });
      return;
    }
    try {
      await this.engine.getNetwork(networkName).connect({ Container: traefikId });
    } catch (error) {
      if (!messageOf(error).includes("already exists")) {
        throw error;
      }
    }
  }

  private async removeSessionNetworks(sessionId: string): Promise<void> {
    try {
      const networks = await this.engine.listNetworks({
        filters: { label: [`${SESSION_LABEL_KEY}=${sessionId}`, `${MANAGED_LABEL_KEY}=true`] },
      });
      for (const summary of networks) {
        const details = await this.engine.getNetwork(summary.Id).inspect();
        await this.removeNetwork(summary.Id, Object.keys((details.Containers ?? {}) as Record<string, unknown>));
      }
    } catch (error) {
      this.logger?.warn("network.remove_failed", { sessionId, message: messageOf(error) });
    }
  }

  private async removeNetwork(networkId: string, attachedContainerIds: readonly string[]): Promise<void> {
    const network = this.engine.getNetwork(networkId);
    for (const containerId of attachedContainerIds) {
      await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
    }
    try {
      await network.remove();
    } catch (error) {
      if (statusCodeOf(error) !== 404) {
        throw error;
      }
    }
  }
}