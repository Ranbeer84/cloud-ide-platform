import { spawn } from "node-pty";
const DEFAULT_SHELL = "bash";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
function isClientMessage(value) {
    if (typeof value !== "object" || value === null || !("type" in value)) {
        return false;
    }
    const record = value;
    if (record["type"] === "input") {
        return typeof record["data"] === "string";
    }
    if (record["type"] === "resize") {
        return typeof record["cols"] === "number" && typeof record["rows"] === "number";
    }
    return false;
}
/**
 * Owns exactly one PTY process and bridges it to exactly one websocket
 * connection. One bridge is created per terminal session; disposing it
 * kills the underlying shell so no orphaned processes are left behind.
 */
export class PtyBridge {
    pty;
    closed = false;
    constructor(options = {}) {
        this.pty = spawn(options.shell ?? DEFAULT_SHELL, [], {
            name: "xterm-256color",
            cols: options.cols ?? DEFAULT_COLS,
            rows: options.rows ?? DEFAULT_ROWS,
            cwd: options.cwd ?? process.env["SANDBOX_WORKDIR"] ?? "/workspace",
            env: {
                ...process.env,
                ...(options.env ?? {}),
            },
        });
    }
    /** Wires this PTY's lifecycle to a single websocket connection. */
    attach(socket) {
        const dataSub = this.pty.onData((data) => {
            this.send(socket, { type: "output", data });
        });
        const exitSub = this.pty.onExit(({ exitCode, signal }) => {
            // exactOptionalPropertyTypes forbids passing `signal: undefined` explicitly,
            // so the key is omitted entirely rather than set to undefined.
            const message = signal === undefined
                ? { type: "exit", exitCode }
                : { type: "exit", exitCode, signal };
            this.send(socket, message);
            this.dispose();
        });
        socket.on("message", (raw) => {
            this.handleRawMessage(raw, socket);
        });
        socket.on("close", () => {
            dataSub.dispose();
            exitSub.dispose();
            this.dispose();
        });
        socket.on("error", () => {
            this.dispose();
        });
    }
    handleRawMessage(raw, socket) {
        let parsed;
        try {
            parsed = JSON.parse(raw.toString());
        }
        catch {
            this.send(socket, { type: "error", message: "Invalid message: expected JSON." });
            return;
        }
        if (!isClientMessage(parsed)) {
            this.send(socket, { type: "error", message: "Unrecognized message shape." });
            return;
        }
        if (parsed.type === "input") {
            this.pty.write(parsed.data);
            return;
        }
        // resize
        if (parsed.cols > 0 && parsed.rows > 0) {
            this.pty.resize(parsed.cols, parsed.rows);
        }
    }
    send(socket, message) {
        if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    }
    /** Kills the underlying PTY process. Safe to call more than once. */
    dispose() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            this.pty.kill();
        }
        catch {
            // Process may have already exited; nothing further to do.
        }
    }
}
//# sourceMappingURL=ptyBridge.js.map