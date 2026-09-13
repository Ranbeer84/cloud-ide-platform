/**
 * Hard resource limits applied to every spawned sandbox container.
 * These map directly onto Docker's HostConfig fields.
 */
export interface ContainerResourceLimits {
    /** Hard memory ceiling in bytes, e.g. 512 * 1024 * 1024 for 512MB. */
    readonly memoryBytes: number;
    /**
     * Total memory+swap ceiling in bytes. Set equal to memoryBytes to disable
     * swap entirely so the memory limit is meaningfully enforced.
     */
    readonly memorySwapBytes?: number;
    /** CPU quota in nano-CPUs (1_000_000_000 = 1 full core). Optional. */
    readonly nanoCpus?: number;
    /** Max number of processes/threads inside the container. Optional. */
    readonly pidsLimit?: number;
}
/**
 * Free-form labels attached to a container.
 *
 * This is deliberately an open string->string map (rather than a fixed set
 * of known keys) so that Phase 3's reverse-proxy routing labels can be
 * merged in by callers without any change to dockerManager's signatures.
 */
export type ContainerLabels = Readonly<Record<string, string>>;
export interface SpawnContainerOptions {
    /** Image reference to run, e.g. "live/sandbox-base:latest". */
    readonly image: string;
    /** Logical session this container belongs to. */
    readonly sessionId: string;
    /** The port the sandbox-agent listens on inside the container. */
    readonly agentPort: number;
    readonly resourceLimits: ContainerResourceLimits;
    /** Extra labels merged on top of dockerManager's own bookkeeping labels. */
    readonly labels?: ContainerLabels;
    /** Extra environment variables passed into the container. */
    readonly env?: Readonly<Record<string, string>>;
}
export type ManagedContainerStatus = "starting" | "running" | "stopped" | "oom_killed" | "exited" | "error";
export interface ManagedContainer {
    readonly containerId: string;
    readonly sessionId: string;
    readonly image: string;
    /** Host-side port that maps to the container's agentPort. */
    readonly hostAgentPort: number;
    readonly labels: ContainerLabels;
    readonly createdAt: number;
    readonly status: ManagedContainerStatus;
}
export interface ContainerInspection {
    readonly containerId: string;
    readonly running: boolean;
    readonly oomKilled: boolean;
    readonly exitCode: number | null;
    readonly status: string;
}
export interface ExecResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
export interface StopContainerOptions {
    /** Grace period before SIGKILL, in seconds. Defaults to 5. */
    readonly timeoutSeconds?: number;
}
//# sourceMappingURL=containerTypes.d.ts.map