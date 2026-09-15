import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface ReadOnlyTerminalProps {
  /** Full websocket URL to the sandbox-agent's PTY endpoint, e.g. "ws://localhost:32768/pty". */
  readonly wsUrl: string;
}

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
 * Read-only view of a sandbox terminal. Renders PTY output exactly like
 * the host's Terminal component, but `disableStdin: true` stops xterm
 * from capturing keystrokes at all -- there is no code path here that
 * could forward viewer input to the shell, by construction rather than
 * by convention.
 *
 * Note: Phase 1's PtyBridge spawns one fresh shell per websocket
 * connection, so this currently renders an independent shell rather than
 * a live mirror of the host's exact session. True multi-viewer mirroring
 * of a single shared shell would need a small PtyBridge extension
 * (broadcast to multiple attached sockets, single writer) -- deliberately
 * left out of Phase 2 to avoid touching Phase 1's already-verified
 * terminal path. Happy to add that as a follow-up.
 */
export function ReadOnlyTerminal({ wsUrl }: ReadOnlyTerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const term = new XTerm({
      cursorBlink: false,
      convertEol: true,
      fontSize: 14,
      disableStdin: true,
      theme: { background: "#111318" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
      term.writeln("Connected (read-only).");
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

    const resizeObserver = new ResizeObserver(() => fitAddon.fit());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      socket.close();
      term.dispose();
    };
  }, [wsUrl]);

  return <div ref={containerRef} style={{ width: "100%", height: "400px" }} />;
}
