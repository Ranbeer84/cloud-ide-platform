import Docker from "dockerode";
/** Label used to identify (and later list/filter) every container we spawn. */
const MANAGED_LABEL_KEY = "live.managed";
const SESSION_LABEL_KEY = "live.session-id";
function toDockerEnv(env) {
    if (!env) {
        return undefined;
    }
    return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}
/**
 * Thin, testable wrapper around dockerode covering exactly the container
 * lifecycle the orchestrator needs: spawn, exec, inspect, stop.
 *
 * Labels passed into spawnContainer are merged with our own bookkeeping
 * labels rather than replacing them, and are stored as-is on the returned
 * ManagedContainer. This is the extension point Phase 3 uses to attach
 * reverse-proxy routing labels without touching this class's logic.
 */
export class DockerManager {
    docker;
    constructor(docker = new Docker()) {
        this.docker = docker;
    }
    async spawnContainer(options) {
        const labels = {
            [MANAGED_LABEL_KEY]: "true",
            [SESSION_LABEL_KEY]: options.sessionId,
            ...(options.labels ?? {}),
        };
        const containerPort = `${options.agentPort}/tcp`;
        const container = await this.docker.createContainer({
            Image: options.image,
            Labels: labels,
            Env: toDockerEnv(options.env),
            ExposedPorts: { [containerPort]: {} },
            HostConfig: {
                Memory: options.resourceLimits.memoryBytes,
                MemorySwap: options.resourceLimits.memorySwapBytes ?? options.resourceLimits.memoryBytes,
                NanoCpus: options.resourceLimits.nanoCpus,
                PidsLimit: options.resourceLimits.pidsLimit,
                PortBindings: { [containerPort]: [{ HostPort: "0" }] },
                RestartPolicy: { Name: "no" },
            },
            Tty: false,
        });
        await container.start();
        const inspectResult = await container.inspect();
        const portBindings = inspectResult.NetworkSettings.Ports[containerPort];
        const hostPort = portBindings?.[0]?.HostPort;
        if (!hostPort) {
            throw new Error(`Container ${container.id} did not publish expected port ${containerPort}`);
        }
        return {
            containerId: container.id,
            sessionId: options.sessionId,
            image: options.image,
            hostAgentPort: Number(hostPort),
            labels,
            createdAt: Date.now(),
            status: "running",
        };
    }
    async inspectContainer(containerId) {
        const container = this.docker.getContainer(containerId);
        const data = await container.inspect();
        return {
            containerId: data.Id,
            running: data.State.Running,
            oomKilled: data.State.OOMKilled,
            exitCode: data.State.ExitCode ?? null,
            status: data.State.Status,
        };
    }
    /**
     * Runs a one-off command inside a running container and collects its
     * combined output. Used both by the orchestrator's own health checks and
     * by Phase 1 verification (e.g. `echo hello`, `cat /proc/1/cgroup`).
     */
    async execInContainer(containerId, cmd) {
        const container = this.docker.getContainer(containerId);
        const exec = await container.exec({
            Cmd: [...cmd],
            AttachStdout: true,
            AttachStderr: true,
        });
        const stream = await exec.start({ Detach: false, Tty: false });
        const stdoutChunks = [];
        const stderrChunks = [];
        await new Promise((resolve, reject) => {
            this.docker.modem.demuxStream(stream, { write: (chunk) => stdoutChunks.push(chunk) }, { write: (chunk) => stderrChunks.push(chunk) });
            stream.on("end", resolve);
            stream.on("error", reject);
        });
        const execInspect = await exec.inspect();
        return {
            exitCode: execInspect.ExitCode,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
        };
    }
    async stopContainer(containerId, options = {}) {
        const container = this.docker.getContainer(containerId);
        try {
            await container.stop({ t: options.timeoutSeconds ?? 5 });
        }
        catch (error) {
            if (!isAlreadyStoppedOrMissing(error)) {
                throw error;
            }
        }
        try {
            await container.remove({ force: true });
        }
        catch (error) {
            if (!isAlreadyStoppedOrMissing(error)) {
                throw error;
            }
        }
    }
    /** Lists every container this orchestrator has spawned, running or not. */
    async listManagedContainers() {
        const containers = await this.docker.listContainers({
            all: true,
            filters: { label: [`${MANAGED_LABEL_KEY}=true`] },
        });
        return containers.map((info) => ({
            containerId: info.Id,
            sessionId: info.Labels[SESSION_LABEL_KEY] ?? "unknown",
            image: info.Image,
            hostAgentPort: Number(info.Ports[0]?.PublicPort ?? 0),
            labels: info.Labels,
            createdAt: info.Created * 1000,
            status: info.State === "running" ? "running" : "stopped",
        }));
    }
}
function isAlreadyStoppedOrMissing(error) {
    const statusCode = error?.statusCode;
    // 304 = container already stopped, 404 = container already removed.
    return statusCode === 304 || statusCode === 404;
}
//# sourceMappingURL=dockerManager.js.map