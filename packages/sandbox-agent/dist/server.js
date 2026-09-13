import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { PtyBridge } from "./pty/ptyBridge.js";
const PORT = Number(process.env["PORT"] ?? 7777);
const PTY_PATH = "/pty";
const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
});
const wss = new WebSocketServer({ server: httpServer, path: PTY_PATH });
wss.on("connection", (socket) => {
    // One PTY (one shell process) per websocket connection. The bridge kills
    // its shell as soon as the socket closes, so no orphaned processes can
    // accumulate inside the container across reconnects.
    const bridge = new PtyBridge();
    bridge.attach(socket);
});
httpServer.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[sandbox-agent] listening on port ${PORT} (pty path: ${PTY_PATH})`);
});
//# sourceMappingURL=server.js.map