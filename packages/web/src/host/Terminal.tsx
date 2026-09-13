import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalProps {
  /** Full websocket URL to the sandbox-agent's PTY endpoint, e.g. "ws://localhost:32768/pty". */
  readonly wsUrl: string;
}

/** Messages the sandbox-agent sends back over the websocket. Mirrors ptyBridge.ts's ServerMessage. */
type AgentMessage =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number; readonly signal?: number }
  | { readonly type: "error"; readonly message: string };

function isAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ["output", "exit", "error"].includes((value as { type: unknown }).type as string)
  );
}

/**
 * Renders a live terminal backed by a real PTY running inside a sandbox
 * container. This component owns exactly one websocket connection and one
 * xterm.js instance for its lifetime; both are torn down on unmount so a
 * page navigation can't leak either a socket or a rendered terminal.
 */
export function Terminal({ wsUrl }: TerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontSize: 14,
      theme: { background: "#111318" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const socket = new WebSocket(wsUrl);

    function sendResize(): void {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }

    socket.addEventListener("open", () => {
      term.writeln("Connected. Waiting for shell...");
      sendResize();
    });

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isAgentMessage(parsed)) {
        return;
      }
      if (parsed.type === "output") {
        term.write(parsed.data);
      } else if (parsed.type === "exit") {
        term.writeln(`\r\n[process exited: code=${parsed.exitCode}]`);
      } else {
        term.writeln(`\r\n[error: ${parsed.message}]`);
      }
    });

    socket.addEventListener("close", () => {
      term.writeln("\r\n[connection closed]");
    });

    socket.addEventListener("error", () => {
      term.writeln("\r\n[connection error]");
    });

    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      socket.close();
      term.dispose();
    };
  }, [wsUrl]);

  return <div ref={containerRef} style={{ width: "100%", height: "400px" }} />;
}
