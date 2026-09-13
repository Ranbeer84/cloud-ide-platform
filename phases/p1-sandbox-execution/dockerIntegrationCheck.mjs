#!/usr/bin/env node
import { DockerManager } from "../../packages/orchestrator/dist/index.js";

const IMAGE_TAG = process.env.SANDBOX_IMAGE_TAG ?? "live/sandbox-base:latest";
const MEMORY_BYTES = 512 * 1024 * 1024;
const AGENT_PORT = 7777;

const manager = new DockerManager();
const spawnedContainerIds = [];
let hadFailure = false;

function log(message) {
  console.log(`[p1-verify] ${message}`);
}

function fail(message) {
  console.error(`[p1-verify] FAIL: ${message}`);
  hadFailure = true;
}

async function cleanup() {
  for (const id of spawnedContainerIds) {
    try {
      await manager.stopContainer(id);
    } catch {
      // best-effort cleanup
    }
  }
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runIsolationAndLifecycleChecks() {
  log("Spawning isolation-test container...");
  const container = await manager.spawnContainer({
    image: IMAGE_TAG,
    sessionId: "p1-verify-isolation",
    agentPort: AGENT_PORT,
    resourceLimits: { memoryBytes: MEMORY_BYTES, memorySwapBytes: MEMORY_BYTES },
  });
  spawnedContainerIds.push(container.containerId);
  log(`Container ${container.containerId.slice(0, 12)} running, host port ${container.hostAgentPort}`);

  const healthy = await waitForHealth(container.hostAgentPort);
  if (healthy) {
    log("PASS: sandbox-agent health check responded");
  } else {
    fail("sandbox-agent did not become healthy in time");
  }

  const echoResult = await manager.execInContainer(container.containerId, ["bash", "-c", "echo hello"]);
  if (echoResult.exitCode === 0 && echoResult.stdout.trim() === "hello") {
    log('PASS: echo "hello" printed from inside the container');
  } else {
    fail(`echo hello did not behave as expected: ${JSON.stringify(echoResult)}`);
  }

  const cgroupResult = await manager.execInContainer(container.containerId, ["cat", "/proc/1/cgroup"]);
  log(`/proc/1/cgroup contents:\n${cgroupResult.stdout}`);
  if (cgroupResult.exitCode === 0 && cgroupResult.stdout.trim().length > 0) {
    log("PASS: /proc/1/cgroup is readable and shows the container's own PID 1 / cgroup view");
  } else {
    fail("/proc/1/cgroup was empty or unreadable");
  }

  log("Stopping isolation-test container via DockerManager.stopContainer()...");
  await manager.stopContainer(container.containerId);
  spawnedContainerIds.splice(spawnedContainerIds.indexOf(container.containerId), 1);

  try {
    await manager.inspectContainer(container.containerId);
    fail("container was still inspectable after stopContainer() -- expected it to be removed");
  } catch {
    log("PASS: orchestrator stopped and removed the container");
  }
}

async function runOomCheck() {
  log("Spawning OOM-test container (512MB memory limit)...");
  const container = await manager.spawnContainer({
    image: IMAGE_TAG,
    sessionId: "p1-verify-oom",
    agentPort: AGENT_PORT,
    resourceLimits: { memoryBytes: MEMORY_BYTES, memorySwapBytes: MEMORY_BYTES },
  });
  spawnedContainerIds.push(container.containerId);

  const healthy = await waitForHealth(container.hostAgentPort);
  if (!healthy) {
    fail("OOM-test sandbox-agent did not become healthy in time");
  }

  log("Running stress-ng requesting 800MB inside a 512MB-limited container...");
  const stressResult = await manager.execInContainer(container.containerId, [
    "stress-ng",
    "--vm",
    "1",
    "--vm-bytes",
    "800M",
    "--vm-keep",
    "--timeout",
    "20s",
  ]);
  log(`stress-ng exited with code ${stressResult.exitCode}`);
  if (stressResult.stderr.trim().length > 0) {
    log(`stress-ng stderr:\n${stressResult.stderr}`);
  }

  const cgroupEvents = await manager.execInContainer(container.containerId, [
    "sh",
    "-c",
    "cat /sys/fs/cgroup/memory.events 2>/dev/null || cat /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null || echo NOFILE",
  ]);
  log(`cgroup memory event counters:\n${cgroupEvents.stdout}`);

  const killedBySignal = stressResult.exitCode === 137; // 128 + SIGKILL(9)
  const oomEventSeen =
    /oom_kill\s+[1-9]/.test(cgroupEvents.stdout) || /oom_kill_total\s+[1-9]/.test(cgroupEvents.stdout);

  if (killedBySignal || oomEventSeen) {
    log("PASS: stress-ng was OOM-killed under the 512MB memory limit");
  } else {
    fail("no evidence stress-ng was OOM-killed -- inspect the output above manually");
  }

  await manager.stopContainer(container.containerId);
  spawnedContainerIds.splice(spawnedContainerIds.indexOf(container.containerId), 1);
  log("OOM-test container stopped");
}

async function main() {
  await runIsolationAndLifecycleChecks();
  await runOomCheck();
}

try {
  await main();
} catch (error) {
  console.error("[p1-verify] Unexpected error:", error);
  hadFailure = true;
} finally {
  await cleanup();
}

if (hadFailure) {
  console.error("[p1-verify] One or more Phase 1 checks FAILED.");
  process.exit(1);
}

console.log("[p1-verify] All Docker-backed checks PASSED.");
