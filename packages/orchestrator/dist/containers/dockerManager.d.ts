import Docker from "dockerode";
import type { ContainerInspection, ExecResult, ManagedContainer, SpawnContainerOptions, StopContainerOptions } from "./containerTypes.js";
/**
 * Thin, testable wrapper around dockerode covering exactly the container
 * lifecycle the orchestrator needs: spawn, exec, inspect, stop.
 *
 * Labels passed into spawnContainer are merged with our own bookkeeping
 * labels rather than replacing them, and are stored as-is on the returned
 * ManagedContainer. This is the extension point Phase 3 uses to attach
 * reverse-proxy routing labels without touching this class's logic.
 */
export declare class DockerManager {
    private readonly docker;
    constructor(docker?: Docker);
    spawnContainer(options: SpawnContainerOptions): Promise<ManagedContainer>;
    inspectContainer(containerId: string): Promise<ContainerInspection>;
    /**
     * Runs a one-off command inside a running container and collects its
     * combined output. Used both by the orchestrator's own health checks and
     * by Phase 1 verification (e.g. `echo hello`, `cat /proc/1/cgroup`).
     */
    execInContainer(containerId: string, cmd: readonly string[]): Promise<ExecResult>;
    stopContainer(containerId: string, options?: StopContainerOptions): Promise<void>;
    /** Lists every container this orchestrator has spawned, running or not. */
    listManagedContainers(): Promise<readonly ManagedContainer[]>;
}
//# sourceMappingURL=dockerManager.d.ts.map