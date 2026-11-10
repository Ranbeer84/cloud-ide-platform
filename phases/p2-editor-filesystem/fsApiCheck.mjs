#!/usr/bin/env node
import { DockerManager } from "../../packages/orchestrator/dist/index.js";
import WebSocket from "ws";

const IMAGE_TAG = process.env.SANDBOX_IMAGE_TAG ?? "live/sandbox-base:latest";
const MEMORY_BYTES = 512 * 1024 * 1024;
const AGENT_PORT = 7777;

const manager = new DockerManager();
let containerId;
let hadFailure = false;

function log(message) {
  console.log(`[p2-verify] ${message}`);
}

function fail(message) {
  console.error(`[p2-verify] FAIL: ${message}`);
  hadFailure = true;
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

function connectFsEvents(port) {
  const events = [];
  const socket = new WebSocket(`ws://localhost:${port}/fs/events`);
  const ready = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (raw) => {
    try {
      events.push(JSON.parse(raw.toString()));
    } catch {
      // ignore malformed frames
    }
  });
  return { socket, events, ready };
}

async function waitForEvent(events, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function main() {
  log("Spawning editor/filesystem test container...");
  const container = await manager.spawnContainer({
    image: IMAGE_TAG,
    sessionId: "p2-verify",
    agentPort: AGENT_PORT,
    resourceLimits: { memoryBytes: MEMORY_BYTES, memorySwapBytes: MEMORY_BYTES },
  });
  containerId = container.containerId;
  const baseUrl = `http://localhost:${container.hostAgentPort}`;
  log(`Container running, host port ${container.hostAgentPort}`);

  if (!(await waitForHealth(container.hostAgentPort))) {
    fail("sandbox-agent did not become healthy in time");
    return;
  }
  log("PASS: sandbox-agent healthy");

  const { socket, events, ready } = connectFsEvents(container.hostAgentPort);
  await ready;
  log("PASS: connected to /fs/events websocket");

  // --- CREATE ---
  const createRes = await fetch(`${baseUrl}/fs/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "hello.py", kind: "file", content: "print('hi')\n" }),
  });
  if (createRes.status === 201) {
    log("PASS: create hello.py via File API");
  } else {
    fail(`create hello.py failed: ${createRes.status}`);
  }

  const createEvent = await waitForEvent(events, (e) => e.type === "create" && e.entry?.path === "hello.py");
  if (createEvent) {
    log("PASS: /fs/events reported create for hello.py");
  } else {
    fail("no create event observed for hello.py");
  }

  const treeAfterCreate = await (await fetch(`${baseUrl}/fs/tree`)).json();
  if (JSON.stringify(treeAfterCreate).includes("hello.py")) {
    log("PASS: file tree includes hello.py after create");
  } else {
    fail("file tree does not include hello.py after create");
  }

  // --- EDIT / SAVE ---
  const updateRes = await fetch(`${baseUrl}/fs/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "hello.py", content: "print('updated')\n" }),
  });
  if (updateRes.ok) {
    log("PASS: update hello.py via File API");
  } else {
    fail(`update hello.py failed: ${updateRes.status}`);
  }

  const readBack = await (await fetch(`${baseUrl}/fs/file?path=hello.py`)).json();
  if (readBack.content === "print('updated')\n") {
    log("PASS: read-back content matches saved edit");
  } else {
    fail(`read-back content mismatch: ${JSON.stringify(readBack)}`);
  }

  const updateEvent = await waitForEvent(events, (e) => e.type === "update" && e.entry?.path === "hello.py");
  if (updateEvent) {
    log("PASS: /fs/events reported update for hello.py");
  } else {
    fail("no update event observed for hello.py");
  }

  // --- RENAME ---
  const renameRes = await fetch(`${baseUrl}/fs/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromPath: "hello.py", toPath: "renamed.py" }),
  });
  if (renameRes.ok) {
    log("PASS: rename hello.py -> renamed.py via File API");
  } else {
    fail(`rename failed: ${renameRes.status}`);
  }

  const renameEvent = await waitForEvent(
    events,
    (e) => e.type === "rename" && e.from?.path === "hello.py" && e.to?.path === "renamed.py",
  );
  if (renameEvent) {
    log("PASS: /fs/events reported rename hello.py -> renamed.py");
  } else {
    fail("no rename event observed");
  }

  const treeAfterRename = await (await fetch(`${baseUrl}/fs/tree`)).json();
  const treeText = JSON.stringify(treeAfterRename);
  if (treeText.includes("renamed.py") && !treeText.includes("hello.py")) {
    log("PASS: file tree reflects rename");
  } else {
    fail("file tree does not correctly reflect rename");
  }

  // --- Language-relevant file types round-trip (backs the Monaco language test) ---
  const languageFiles = [
    ["sample.js", "console.log('js');\n"],
    ["sample.ts", "const x: number = 1;\n"],
    ["sample.py", "print('py')\n"],
  ];
  for (const [filePath, content] of languageFiles) {
    const res = await fetch(`${baseUrl}/fs/file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, kind: "file", content }),
    });
    if (res.status === 201) {
      log(`PASS: created ${filePath} (backing store for Monaco language test)`);
    } else {
      fail(`failed to create ${filePath}: ${res.status}`);
    }
  }

  // --- DELETE ---
  const deleteRes = await fetch(`${baseUrl}/fs/file?path=${encodeURIComponent("renamed.py")}`, {
    method: "DELETE",
  });
  if (deleteRes.ok) {
    log("PASS: delete renamed.py via File API");
  } else {
    fail(`delete failed: ${deleteRes.status}`);
  }

  const deleteEvent = await waitForEvent(events, (e) => e.type === "delete" && e.entry?.path === "renamed.py");
  if (deleteEvent) {
    log("PASS: /fs/events reported delete for renamed.py");
  } else {
    fail("no delete event observed for renamed.py");
  }

  const treeAfterDelete = await (await fetch(`${baseUrl}/fs/tree`)).json();
  if (!JSON.stringify(treeAfterDelete).includes("renamed.py")) {
    log("PASS: file tree no longer includes deleted file");
  } else {
    fail("file tree still includes deleted file");
  }

  // --- Path traversal is rejected ---
  const traversalRes = await fetch(`${baseUrl}/fs/file?path=${encodeURIComponent("../../etc/passwd")}`);
  if (traversalRes.status === 400) {
    log("PASS: path traversal outside the workspace is rejected");
  } else {
    fail(`path traversal was not rejected as expected (status ${traversalRes.status})`);
  }

  // --- Watcher picks up terminal-driven changes ---
  log("Exercising watcher.ts via a terminal-equivalent fs mutation (docker exec)...");
  await manager.execInContainer(containerId, ["bash", "-c", "echo 'from terminal' > fromterminal.txt"]);
  const terminalCreateEvent = await waitForEvent(
    events,
    (e) => (e.type === "create" || e.type === "update") && e.entry?.path === "fromterminal.txt",
    8000,
  );
  if (terminalCreateEvent) {
    log("PASS: watcher.ts detected a file created outside the File API");
  } else {
    fail("watcher.ts did not report the terminal-created file in time");
  }

  socket.close();
}

try {
  await main();
} catch (error) {
  console.error("[p2-verify] Unexpected error:", error);
  hadFailure = true;
} finally {
  if (containerId) {
    try {
      await manager.stopContainer(containerId);
      log("Container stopped");
    } catch {
      // best effort
    }
  }
}

if (hadFailure) {
  console.error("[p2-verify] One or more Phase 2 checks FAILED.");
  process.exit(1);
}

console.log("[p2-verify] All File API / fs-event / watcher checks PASSED.");
