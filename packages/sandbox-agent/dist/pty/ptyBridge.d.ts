import type { WebSocket } from "ws";
export interface PtyBridgeOptions {
    readonly shell?: string;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly cols?: number;
    readonly rows?: number;
}
/** Messages the terminal client sends to the sandbox agent. */
export type ClientMessage = {
    readonly type: "input";
    readonly data: string;
} | {
    readonly type: "resize";
    readonly cols: number;
    readonly rows: number;
};
/** Messages the sandbox agent sends back to the terminal client. */
export type ServerMessage = {
    readonly type: "output";
    readonly data: string;
} | {
    readonly type: "exit";
    readonly exitCode: number;
    readonly signal?: number;
} | {
    readonly type: "error";
    readonly message: string;
};
/**
 * Owns exactly one PTY process and bridges it to exactly one websocket
 * connection. One bridge is created per terminal session; disposing it
 * kills the underlying shell so no orphaned processes are left behind.
 */
export declare class PtyBridge {
    private readonly pty;
    private closed;
    constructor(options?: PtyBridgeOptions);
    /** Wires this PTY's lifecycle to a single websocket connection. */
    attach(socket: WebSocket): void;
    private handleRawMessage;
    private send;
    /** Kills the underlying PTY process. Safe to call more than once. */
    dispose(): void;
}
//# sourceMappingURL=ptyBridge.d.ts.map