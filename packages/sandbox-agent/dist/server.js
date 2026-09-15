import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { PtyBridge } from "./pty/ptyBridge.js";
import { createFileRouter } from "./fs/fileApi.js";
import { FsWatcher } from "./fs/watcher.js";
const PORT = Number(process.env["PORT"] ?? 7777);
const WORKSPACE_ROOT = process.env["SANDBOX_WORKDIR"] ?? "/workspace";
const PTY_PATH = "/pty";
const FS_EVENTS_PATH = "/fs/events";
const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});
// Every connected /fs/events client gets every fs change, whether it came
// from the File API (create/update/rename/delete) or from FsWatcher
// observing a change made directly in the terminal.
const fsEventSockets = new Set();
function broadcastFsEvent(event) {
    const payload = JSON.stringify(event);
    for (const socket of fsEventSockets) {
        if (socket.readyState === socket.OPEN) {
            socket.send(payload);
        }
    }
}
app.use("/fs", createFileRouter({ rootDir: WORKSPACE_ROOT, onChange: broadcastFsEvent }));
const httpServer = createServer(app);
// IMPORTANT: both of these must be created with `noServer: true` and
// dispatched manually below. If each WebSocketServer is instead given
// `{ server: httpServer, path }` directly, `ws` attaches its own internal
// 'upgrade' listener to httpServer for each instance, and those listeners
// fire in registration order for *every* upgrade request regardless of
// path. The first one whose path doesn't match calls shouldHandle() ->
// false -> immediately aborts the handshake with a 400 and destroys the
// socket, instead of leaving it for the next listener. In practice this
// means whichever WebSocketServer is constructed first "wins" and any
// request for the other path gets a 400 before it ever reaches the
// matching server. Manually routing on the shared 'upgrade' event avoids
// that race entirely.
const ptyWss = new WebSocketServer({ noServer: true });
ptyWss.on("connection", (socket) => {
    // One PTY (one shell process) per websocket connection. The bridge kills
    // its shell as soon as the socket closes, so no orphaned processes can
    // accumulate inside the container across reconnects.
    const bridge = new PtyBridge();
    bridge.attach(socket);
});
const fsEventsWss = new WebSocketServer({ noServer: true });
fsEventsWss.on("connection", (socket) => {
    fsEventSockets.add(socket);
    socket.on("close", () => fsEventSockets.delete(socket));
});
httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "", `http://${request.headers.host}`);
    if (pathname === PTY_PATH) {
        ptyWss.handleUpgrade(request, socket, head, (ws) => {
            ptyWss.emit("connection", ws, request);
        });
    }
    else if (pathname === FS_EVENTS_PATH) {
        fsEventsWss.handleUpgrade(request, socket, head, (ws) => {
            fsEventsWss.emit("connection", ws, request);
        });
    }
    else {
        socket.destroy();
    }
});
const watcher = new FsWatcher({ rootDir: WORKSPACE_ROOT, onChange: broadcastFsEvent });
watcher.start();
httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[sandbox-agent] listening on port ${PORT} (pty: ${PTY_PATH}, fs events: ${FS_EVENTS_PATH})`);
});
//# sourceMappingURL=server.js.map