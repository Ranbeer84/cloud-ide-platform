import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import type { ReadFileResponse } from "@live/shared-types";

export interface ReadOnlyEditorProps {
  /** Base HTTP URL of the sandbox-agent, e.g. "http://localhost:32768". */
  readonly apiBaseUrl: string;
  /** Base WS URL of the sandbox-agent, e.g. "ws://localhost:32768". */
  readonly wsBaseUrl: string;
  /** Relative path of the file to mirror. Typically driven by the host's current selection. */
  readonly activePath: string | undefined;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".html": "html",
};

function detectLanguage(filePath: string): string {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) {
    return "plaintext";
  }
  return LANGUAGE_BY_EXTENSION[filePath.slice(dotIndex)] ?? "plaintext";
}

interface FsChangeEventLike {
  readonly type: "create" | "update" | "delete" | "rename";
  readonly entry?: { readonly path: string };
  readonly to?: { readonly path: string };
}

/**
 * Read-only mirror of whatever file `activePath` points to. `readOnly:
 * true` is enforced at the Monaco options level, so there is no code path
 * here that could write back to the sandbox even if wired up incorrectly
 * by a caller.
 *
 * Content refreshes whenever an /fs/events message touches activePath
 * (an update to its content, or it being the target of a rename). This
 * component does not decide *which* file is active -- that is driven by
 * whatever supplies `activePath` to it.
 */
export function ReadOnlyEditor({ apiBaseUrl, wsBaseUrl, activePath }: ReadOnlyEditorProps): JSX.Element {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!activePath) {
      setContent("");
      return;
    }
    let cancelled = false;
    fetch(`${apiBaseUrl}/fs/file?path=${encodeURIComponent(activePath)}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load file: ${res.status}`);
        }
        return res.json() as Promise<ReadFileResponse>;
      })
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setError(undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load file");
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, activePath]);

  useEffect(() => {
    if (!activePath) return;
    const socket = new WebSocket(`${wsBaseUrl}/fs/events`);
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      let parsed: FsChangeEventLike;
      try {
        parsed = JSON.parse(event.data) as FsChangeEventLike;
      } catch {
        return;
      }
      const touchedPath = parsed.entry?.path ?? parsed.to?.path;
      if (touchedPath !== activePath) {
        return;
      }
      if (parsed.type === "delete") {
        setContent("");
        return;
      }
      fetch(`${apiBaseUrl}/fs/file?path=${encodeURIComponent(activePath)}`)
        .then((res) => (res.ok ? (res.json() as Promise<ReadFileResponse>) : Promise.reject(res.status)))
        .then((data) => setContent(data.content))
        .catch(() => undefined);
    });
    return () => socket.close();
  }, [apiBaseUrl, wsBaseUrl, activePath]);

  if (!activePath) {
    return (
      <div style={{ padding: "1rem", color: "#888", fontFamily: "sans-serif" }}>
        Waiting for the host to open a file...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "0.25rem 0.5rem", fontSize: 12, color: "#aaa", fontFamily: "sans-serif" }}>
        {activePath} {error && <span style={{ color: "crimson" }}>— {error}</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language={detectLanguage(activePath)}
          value={content}
          theme="vs-dark"
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
        />
      </div>
    </div>
  );
}
