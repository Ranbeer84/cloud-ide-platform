#!/usr/bin/env node
/**
 * Phase 7 sandbox security check. Needs Docker with the gVisor (runsc) runtime
 * registered, the sandbox image built, and (for the network section) the host
 * firewall from scripts/apply-sandbox-firewall.sh installed.
 *
 * It spawns real sandboxes through GvisorManager, the same class the
 * orchestrator uses, and proves:
 *   A. containers run under runsc, as non-root, with no capabilities, and the
 *      agent port is published on loopback only
 *   B. the terminal (pty) still behaves correctly under runsc: tty allocation,
 *      window-size ioctls, termios modes, line-discipline signals, job
 *      control, UTF-8, bulk output, EOF
 *   C. a sandbox cannot connect to another sandbox, to the host through its
 *      bridge gateway or any of the host's addresses, or to metadata endpoints
 *   D. stopping a sandbox removes its network, and orphaned networks are pruned
 *
 * Environment: SANDBOX_IMAGE (default live/sandbox-base:latest)
 *              P7_METADATA_IP (optional) an address already assigned to the host's
 *              loopback to stand in for the metadata service, e.g. 169.254.169.254
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { GvisorManager, SANDBOX_RUNTIME, sessionNetworkName } = await import(
  pathToFileURL(path.join(repoRoot, "packages/orchestrator/dist/index.js")).href
);

const IMAGE = process.env.SANDBOX_IMAGE ?? "live/sandbox-base:latest";
const AGENT_PORT = 7777;
const PROBE_TIMEOUT_MS = 3000;
const METADATA_IP = process.env.P7_METADATA_IP ?? "169.254.169.254";

function pass(message) {
  console.log(`  PASS: ${message}`);
}
function note(message) {
  console.log(`  NOTE: ${message}`);
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  pass(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Exact-name lookup; `docker network ls --filter name=` is a substring match. */
function networkExists(name) {
  return docker("network", "ls", "--format", "{{.Name}}").split("\n").includes(name);
}

const manager = new GvisorManager({});
const spawned = [];
const listeners = [];

async function spawnSandbox(label) {
  const sessionId = `p7${label}${randomBytes(4).toString("hex")}`;
  const container = await manager.spawnContainer({
    image: IMAGE,
    sessionId,
    agentPort: AGENT_PORT,
    resourceLimits: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000, pidsLimit: 256 },
    env: { PORT: String(AGENT_PORT) },
  });
  spawned.push(container);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${container.hostAgentPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return { ...container, network: sessionNetworkName(sessionId) };
      }
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`sandbox ${sessionId} never answered /health`);
}

function exec(sandbox, ...cmd) {
  return manager.execInContainer(sandbox.containerId, cmd);
}

/* ---------------------------------------------------------------- pty */

function openPty(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pty`);
    const session = { ws, buffer: "", mark: 0, exit: undefined, errors: [] };
    const timer = setTimeout(() => reject(new Error("pty websocket did not open in time")), 5000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "output") {
        session.buffer += message.data;
      } else if (message.type === "exit") {
        session.exit = message;
      } else if (message.type === "error") {
        session.errors.push(message.message);
      }
    });
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(session);
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const typeInto = (session, text) => session.ws.send(JSON.stringify({ type: "input", data: text }));
const resizePty = (session, cols, rows) => session.ws.send(JSON.stringify({ type: "resize", cols, rows }));

// CSI sequences (colours, bracketed paste, cursor moves) and OSC sequences (window title).
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/**
 * Waits for `regex` in the terminal output produced since the last match, then
 * discards everything up to it. Escape sequences are stripped first: bash
 * emits bracketed-paste and title sequences around every prompt and line.
 */
async function expectOutput(session, regex, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    const fresh = session.buffer.slice(session.mark).replace(ANSI_PATTERN, "");
    const match = regex.exec(fresh);
    if (match) {
      session.mark = session.buffer.length;
      return match;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${regex} in pty output; last output: ${JSON.stringify(fresh.slice(-300))}`);
    }
    await sleep(25);
  }
}

async function runPtyRegression(sandbox) {
  const pty = await openPty(sandbox.hostAgentPort);
  try {
    // Markers are computed by the shell ($((..))) so the echo of the typed command never matches the result.
    // Interactive shells often alias grep to --color=auto, which wraps matches in escape codes, so grep is told not to.
    typeInto(pty, "echo READY_$((1+1))\n");
    await expectOutput(pty, /READY_2/);
    pass("pty: shell starts under runsc and a command round-trips");

    typeInto(pty, "tty\n");
    const ttyMatch = await expectOutput(pty, /\/dev\/pts\/(\d+)/);
    typeInto(pty, "[ -t 0 ] && [ -t 1 ] && echo ISATTY_$((1+1))\n");
    await expectOutput(pty, /ISATTY_2/);
    pass(`pty: stdin and stdout are a real terminal (/dev/pts/${ttyMatch[1]})`);

    typeInto(pty, "stty size\n");
    await expectOutput(pty, /\b24 80\b/);
    pass("pty: TIOCGWINSZ reports the initial 24x80 window");

    resizePty(pty, 132, 43);
    typeInto(pty, "stty size\n");
    await expectOutput(pty, /\b43 132\b/);
    resizePty(pty, 100, 30);
    typeInto(pty, "stty size\n");
    await expectOutput(pty, /\b30 100\b/);
    pass("pty: TIOCSWINSZ resizes are applied (132x43, then 100x30)");

    typeInto(pty, "stty -icanon -echo min 1 time 0\n");
    typeInto(pty, "stty -a | tr ' ' '\\n' | grep --color=never -x -- '-icanon'\n");
    await expectOutput(pty, /(^|[\r\n])-icanon\r?\n/);
    typeInto(pty, "stty sane\n");
    typeInto(pty, "stty -a | tr ' ' '\\n' | grep --color=never -x -- 'icanon'\n");
    await expectOutput(pty, /(^|[\r\n])icanon\r?\n/);
    pass("pty: termios changes (tcsetattr) take effect and can be restored");

    const interruptStart = Date.now();
    typeInto(pty, "sleep 30\n");
    await sleep(600);
    typeInto(pty, "\x03");
    typeInto(pty, "echo AFTER_INT_$((9*9))\n");
    await expectOutput(pty, /AFTER_INT_81/, 8000);
    assert(Date.now() - interruptStart < 15_000, "pty: Ctrl-C interrupts a foreground process (ISIG, process groups, SIGINT)");

    typeInto(pty, "sleep 60 &\n");
    await expectOutput(pty, /\[1\]/);
    typeInto(pty, "jobs\n");
    await expectOutput(pty, /Running\s+sleep 60/);
    typeInto(pty, "kill %1\n");
    pass("pty: job control works (controlling terminal, background jobs)");

    typeInto(pty, "printf 'h\\xc3\\xa9llo-%s\\n' \"$((2+2))\"\n");
    await expectOutput(pty, /héllo-4/);
    typeInto(pty, "printf '\\xf0\\x9f\\x99\\x82_%s\\n' \"$((3+3))\"\n");
    await expectOutput(pty, /🙂_6/);
    pass("pty: UTF-8 input and output survive the terminal, including 4-byte characters");

    typeInto(pty, "seq 1 $((10000*2)) | tail -n 1\n");
    await expectOutput(pty, /(^|[\r\n])20000\r?\n/, 15_000);
    pass("pty: 20,000 lines of output arrive intact");

    const second = await openPty(sandbox.hostAgentPort);
    try {
      typeInto(second, "tty\n");
      const secondTty = await expectOutput(second, /\/dev\/pts\/(\d+)/);
      assert(secondTty[1] !== ttyMatch[1], `pty: a second terminal gets its own pts (/dev/pts/${secondTty[1]})`);
    } finally {
      second.ws.close();
    }

    typeInto(pty, "\x04");
    const exitedAt = Date.now();
    while (pty.exit === undefined && Date.now() - exitedAt < 8000) {
      await sleep(50);
    }
    assert(pty.exit !== undefined && pty.exit.exitCode === 0, "pty: Ctrl-D (EOF) ends the shell cleanly and the agent reports its exit");
    assert(pty.errors.length === 0, "pty: the agent reported no protocol errors");
  } finally {
    pty.ws.close();
  }
}

/* ------------------------------------------------------------ network */

const PROBE_SCRIPT = [
  'const net = require("net");',
  "const host = process.argv[1];",
  "const port = Number(process.argv[2]);",
  "const socket = net.connect({ host, port });",
  `const timer = setTimeout(() => { console.log("BLOCKED:timeout"); process.exit(0); }, ${PROBE_TIMEOUT_MS});`,
  'socket.on("connect", () => { console.log("CONNECTED"); process.exit(0); });',
  'socket.on("error", (error) => { clearTimeout(timer); console.log("BLOCKED:" + error.code); process.exit(0); });',
].join(" ");

/** Tries a TCP connection from INSIDE the sandbox. */
async function probeFrom(sandbox, host, port) {
  const result = await exec(sandbox, "node", "-e", PROBE_SCRIPT, host, String(port));
  const line = result.stdout.trim().split("\n").pop() ?? "";
  if (!line.startsWith("CONNECTED") && !line.startsWith("BLOCKED")) {
    throw new Error(`probe to ${host}:${port} gave no verdict (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)})`);
  }
  return line;
}

/** Tries a TCP connection from the host (this process). */
function probeFromHost(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("BLOCKED:timeout");
    }, PROBE_TIMEOUT_MS);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("CONNECTED");
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(`BLOCKED:${error.code}`);
    });
  });
}

async function listenOn(host) {
  const hits = { count: 0 };
  const server = net.createServer((socket) => {
    hits.count += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  listeners.push(server);
  return { port: server.address().port, hits };
}

function hostLanAddress() {
  const skip = /^(lo|docker|br-|veth|lsbx|virbr|cni|flannel|cali)/;
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) {
      continue;
    }
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
}

const networkField = (sandbox, field) =>
  docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${sandbox.network}").${field}}}`, sandbox.containerId);

async function runNetworkChecks(a, b) {
  const leaks = [];
  const expectBlocked = async (from, description, host, port, counter) => {
    const verdict = await probeFrom(from, host, port);
    if (verdict === "CONNECTED" || (counter && counter.count > 0)) {
      leaks.push(`${description} (${host}:${port})`);
      console.log(`  LEAK: ${description} -> ${verdict}`);
    } else {
      pass(`${description}: ${verdict}`);
    }
  };

  const ownAgent = await probeFrom(a, "127.0.0.1", AGENT_PORT);
  assert(ownAgent === "CONNECTED", "control: the probe can reach a service that should be reachable (the sandbox's own agent)");

  // Another sandbox, by its address on its own network.
  const bIp = networkField(b, "IPAddress");
  await expectBlocked(a, "sandbox A -> sandbox B's agent by container IP", bIp, AGENT_PORT);

  // The host, through the bridge gateway.
  const gateway = networkField(a, "Gateway");
  const hostListener = await listenOn("0.0.0.0");
  const fromHost = await probeFromHost(gateway, hostListener.port);
  assert(fromHost === "CONNECTED", `control: the host itself can reach its listener on ${gateway}:${hostListener.port}`);
  hostListener.hits.count = 0;
  await expectBlocked(a, "sandbox -> host service via the bridge gateway", gateway, hostListener.port, hostListener.hits);

  // Another sandbox's published agent port, which Docker binds on the host's loopback.
  await expectBlocked(a, "sandbox A -> sandbox B's published agent port via the gateway", gateway, b.hostAgentPort);

  // The host's LAN address.
  const lan = hostLanAddress();
  if (lan === undefined) {
    note("no non-loopback host address found; skipped the host-LAN-address probe");
  } else {
    hostListener.hits.count = 0;
    await expectBlocked(a, "sandbox -> host service via the host's LAN address", lan, hostListener.port, hostListener.hits);
    const lanAgent = await probeFromHost(lan, a.hostAgentPort);
    assert(lanAgent !== "CONNECTED", `the agent port is not reachable on the host's LAN address (${lan}): published on loopback only`);
  }

  // Metadata. Where the address really exists on the host, a listener proves the block is the firewall's doing.
  let metadataListener;
  try {
    metadataListener = await listenOn(METADATA_IP);
  } catch {
    note(`${METADATA_IP} is not assigned to this host, so a failed connection could not be told apart from "no such service". The metadata probe below only proves unreachability here.`);
  }
  if (metadataListener) {
    const reachableFromHost = await probeFromHost(METADATA_IP, metadataListener.port);
    assert(reachableFromHost === "CONNECTED", `control: the host can reach a stand-in metadata service on ${METADATA_IP}:${metadataListener.port}`);
    metadataListener.hits.count = 0;
    await expectBlocked(a, "sandbox -> stand-in metadata service", METADATA_IP, metadataListener.port, metadataListener.hits);
  }
  await expectBlocked(a, "sandbox -> cloud metadata endpoint", "169.254.169.254", 80);

  if (leaks.length > 0) {
    throw new Error(
      `${leaks.length} forbidden connection(s) succeeded:\n    - ${leaks.join("\n    - ")}\n` +
        "  Docker's per-session networks only isolate sandboxes from each other. Blocking the host, private\n" +
        "  networks and metadata needs the host firewall: run `sudo scripts/apply-sandbox-firewall.sh apply`\n" +
        "  (or re-run verify.sh with P7_APPLY_FIREWALL=1), then run this check again.",
    );
  }
}

/* --------------------------------------------------------------- main */

async function checkRuntime(sandbox) {
  const id = sandbox.containerId;
  assert(docker("inspect", "-f", "{{.HostConfig.Runtime}}", id) === SANDBOX_RUNTIME, `docker reports the container's runtime as "${SANDBOX_RUNTIME}"`);

  const hostVersion = os.release();
  const inside = await exec(sandbox, "cat", "/proc/version");
  assert(
    inside.exitCode === 0 && inside.stdout.trim().length > 0 && !inside.stdout.includes(hostVersion),
    `the kernel the sandbox sees is gVisor's, not the host's (host ${hostVersion}; sandbox: ${inside.stdout.trim().slice(0, 60)})`,
  );

  const uid = await exec(sandbox, "id", "-u");
  assert(uid.stdout.trim() !== "0", `the sandbox user is not root (uid ${uid.stdout.trim()})`);

  const capDrop = JSON.parse(docker("inspect", "-f", "{{json .HostConfig.CapDrop}}", id));
  assert(Array.isArray(capDrop) && capDrop.includes("ALL"), "all Linux capabilities are dropped (CapDrop: ALL)");
  const securityOpt = JSON.parse(docker("inspect", "-f", "{{json .HostConfig.SecurityOpt}}", id)) ?? [];
  assert(securityOpt.some((option) => option.startsWith("no-new-privileges")), "no-new-privileges is set");
  assert(docker("inspect", "-f", "{{.HostConfig.Privileged}}", id) === "false", "the container is not privileged");

  const caps = await exec(sandbox, "sh", "-c", "grep -E '^Cap(Eff|Prm)' /proc/self/status");
  const capLines = caps.stdout.trim().split("\n").filter(Boolean);
  if (capLines.length > 0) {
    assert(capLines.every((line) => /:\s*0+$/.test(line)), `the sandbox process holds no capabilities (${capLines.join(" | ")})`);
  } else {
    note("this runtime does not expose Cap* in /proc/self/status; relying on the CapDrop setting above");
  }

  const ports = JSON.parse(docker("inspect", "-f", "{{json .NetworkSettings.Ports}}", id));
  const binding = ports[`${AGENT_PORT}/tcp`]?.[0];
  assert(binding?.HostIp === "127.0.0.1", `the agent port is published on 127.0.0.1 only (HostIp ${binding?.HostIp})`);
  assert(docker("inspect", "-f", "{{.HostConfig.NetworkMode}}", id) === sandbox.network, `the sandbox is on its own network (${sandbox.network}), not the shared one`);
}

async function checkCleanup() {
  const orphan = await spawnSandbox("o");
  const orphanNetwork = orphan.network;
  docker("rm", "-f", orphan.containerId); // simulates a crash: the container vanishes, the network is left behind
  assert(networkExists(orphanNetwork), "after a simulated crash the orphaned session network is still there");
  const removed = await manager.pruneOrphanNetworks(new Set());
  assert(removed.includes(orphanNetwork), "pruneOrphanNetworks removes the orphaned network");
  assert(!networkExists(orphanNetwork), "the orphaned network is gone");

  await manager.stopContainer("0".repeat(64));
  pass("stopping a container that no longer exists is not an error");
}

async function main() {
  console.log("== A. runtime and container hardening ==");
  await manager.assertRunscAvailable();
  pass(`the Docker daemon has the "${SANDBOX_RUNTIME}" runtime registered`);
  const a = await spawnSandbox("a");
  const b = await spawnSandbox("b");
  await checkRuntime(a);
  console.log();

  console.log("== B. pty regression under runsc ==");
  await runPtyRegression(a);
  console.log();

  console.log("== C. network isolation ==");
  await runNetworkChecks(a, b);
  console.log();

  console.log("== D. network lifecycle ==");
  const networksToCheck = [a.network, b.network];
  await manager.stopContainer(a.containerId);
  await manager.stopContainer(b.containerId);
  for (const network of networksToCheck) {
    assert(!networkExists(network), `stopping the sandbox removed its network (${network})`);
  }
  await checkCleanup();
  console.log();
  console.log("All Phase 7 sandbox security checks passed.");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  for (const server of listeners) {
    server.close();
  }
  for (const container of spawned) {
    await manager.stopContainer(container.containerId, { timeoutSeconds: 1 }).catch(() => undefined);
  }
}
process.exit(exitCode);