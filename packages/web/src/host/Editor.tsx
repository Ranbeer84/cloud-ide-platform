import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { ReadFileResponse, UpdateFileRequest } from "@live/shared-types";

export interface HostEditorProps {
  /** Base HTTP URL of the sandbox-agent, e.g. "http://localhost:32768". */
  readonly apiBaseUrl: string;
  /** Relative path of the file currently open, or undefined if none is selected. */
  readonly activePath: string | undefined;
}

/** Maps a file extension to the Monaco language id used for syntax highlighting. */
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

const AUTOSAVE_DELAY_MS = 500;

type SaveStatus = "idle" | "loading" | "saving" | "error";

/**
 * Real Monaco editor wired to the sandbox-agent's File API. Loads the
 * active file's content on selection, autosaves edits after a short
 * debounce, and supports an immediate save via Ctrl/Cmd+S. This component
 * owns no fs-event subscription itself -- FileTree is the one that reacts
 * to /fs/events and drives `activePath`/tree refreshes; this component
 * only cares about the currently selected file's content.
 */
export function HostEditor({ apiBaseUrl, activePath }: HostEditorProps): JSX.Element {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!activePath) {
      setContent("");
      setSavedContent("");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    fetch(`${apiBaseUrl}/fs/file?path=${encodeURIComponent(activePath)}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load file: ${res.status}`);
        }
        return res.json() as Promise<ReadFileResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setContent(data.content);
        setSavedContent(data.content);
        setStatus("idle");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, activePath]);

  const persist = useCallback(
    (nextContent: string) => {
      if (!activePath) return;
      setStatus("saving");
      const body: UpdateFileRequest = { path: activePath, content: nextContent };
      fetch(`${apiBaseUrl}/fs/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Save failed: ${res.status}`);
          }
          setSavedContent(nextContent);
          setStatus("idle");
        })
        .catch(() => setStatus("error"));
    },
    [apiBaseUrl, activePath],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      const next = value ?? "";
      setContent(next);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      saveTimer.current = setTimeout(() => persist(next), AUTOSAVE_DELAY_MS);
    },
    [persist],
  );

  const handleMount: OnMount = (editorInstance, monaco) => {
    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
      }
      persist(editorInstance.getValue());
    });
  };

  if (!activePath) {
    return (
      <div style={{ padding: "1rem", color: "#888", fontFamily: "sans-serif" }}>
        Select a file to begin editing.
      </div>
    );
  }

  const isDirty = content !== savedContent;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "0.25rem 0.5rem",
          fontSize: 12,
          color: "#aaa",
          fontFamily: "sans-serif",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{activePath}</span>
        <span>{status === "saving" ? "Saving..." : isDirty ? "Unsaved changes" : "Saved"}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language={detectLanguage(activePath)}
          value={content}
          onChange={handleChange}
          onMount={handleMount}
          theme="vs-dark"
          options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
        />
      </div>
    </div>
  );
}
