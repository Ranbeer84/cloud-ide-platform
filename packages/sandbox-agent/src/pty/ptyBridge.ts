import type { WebSocket, RawData } from "ws";
import { spawn, type IPty } from "node-pty";

export interface PtyBridgeOptions {
  readonly shell?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

/** Messages the terminal client sends to the sandbox agent. */
export type ClientMessage =
  | { readonly type: "input"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };

/** Messages the sandbox agent sends back to the terminal client. */
export type ServerMessage =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number; readonly signal?: number }
  | { readonly type: "error"; readonly message: string };

const DEFAULT_SHELL = "bash";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
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
  private readonly pty: IPty;
  private closed = false;

  constructor(options: PtyBridgeOptions = {}) {
    this.pty = spawn(options.shell ?? DEFAULT_SHELL, [], {
      name: "xterm-256color",
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      cwd: options.cwd ?? process.env["SANDBOX_WORKDIR"] ?? "/workspace",
      env: {
        ...(process.env as Record<string, string>),
        ...(options.env ?? {}),
      },
    });
  }

  /** Wires this PTY's lifecycle to a single websocket connection. */
  attach(socket: WebSocket): void {
    const dataSub = this.pty.onData((data) => {
      this.send(socket, { type: "output", data });
    });

    const exitSub = this.pty.onExit(({ exitCode, signal }) => {
      // exactOptionalPropertyTypes forbids passing `signal: undefined` explicitly,
      // so the key is omitted entirely rather than set to undefined.
      const message: ServerMessage =
        signal === undefined
          ? { type: "exit", exitCode }
          : { type: "exit", exitCode, signal };
      this.send(socket, message);
      this.dispose();
    });

    socket.on("message", (raw: RawData) => {
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

  private handleRawMessage(raw: RawData, socket: WebSocket): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
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

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /** Kills the underlying PTY process. Safe to call more than once. */
  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.pty.kill();
    } catch {
      // Process may have already exited; nothing further to do.
    }
  }
}
