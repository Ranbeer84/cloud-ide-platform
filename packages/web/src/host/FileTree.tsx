import { useCallback, useEffect, useState } from "react";
import type { FsTreeNode } from "@live/shared-types";

export interface FileTreeProps {
  /** Base HTTP URL of the sandbox-agent, e.g. "http://localhost:32768". */
  readonly apiBaseUrl: string;
  /** Base WS URL of the sandbox-agent, e.g. "ws://localhost:32768". */
  readonly wsBaseUrl: string;
  readonly activePath: string | undefined;
  readonly onSelectFile: (path: string) => void;
}

async function fetchTree(apiBaseUrl: string): Promise<FsTreeNode> {
  const res = await fetch(`${apiBaseUrl}/fs/tree`);
  if (!res.ok) {
    throw new Error(`Failed to load file tree: ${res.status}`);
  }
  return (await res.json()) as FsTreeNode;
}

/**
 * Renders the workspace's live file tree and keeps it in sync two ways:
 * an initial GET /fs/tree, then a full refetch every time any message
 * arrives on /fs/events. Refetching the whole tree (rather than patching
 * it incrementally from the event payload) is deliberately simple: the
 * tree is small, refetches are cheap, and it guarantees the displayed
 * tree can never drift from the real filesystem regardless of event
 * ordering or a dropped message.
 *
 * Because every client (host or viewer) that renders this component
 * points at the same container's File API, host and viewer trees are
 * always in sync with each other by construction -- no separate
 * signalling between host and viewer is needed for tree state.
 */
export function FileTree({ apiBaseUrl, wsBaseUrl, activePath, onSelectFile }: FileTreeProps): JSX.Element {
  const [root, setRoot] = useState<FsTreeNode | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(() => {
    fetchTree(apiBaseUrl)
      .then((tree) => {
        setRoot(tree);
        setError(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load tree"));
  }, [apiBaseUrl]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const socket = new WebSocket(`${wsBaseUrl}/fs/events`);
    socket.addEventListener("message", () => {
      // Payload shape is validated by the sandbox-agent; we only care that
      // *something* changed, so we just trigger a fresh GET /fs/tree.
      reload();
    });
    return () => socket.close();
  }, [wsBaseUrl, reload]);

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function handleCreate(kind: "file" | "directory"): Promise<void> {
    const input = window.prompt(`Path for new ${kind} (relative to workspace root):`);
    if (!input) return;
    await fetch(`${apiBaseUrl}/fs/file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: input, kind, content: kind === "file" ? "" : undefined }),
    });
    reload();
  }

  async function handleRename(nodePath: string): Promise<void> {
    const next = window.prompt("Rename to (relative path):", nodePath);
    if (!next || next === nodePath) return;
    await fetch(`${apiBaseUrl}/fs/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromPath: nodePath, toPath: next }),
    });
    reload();
  }

  async function handleDelete(nodePath: string): Promise<void> {
    if (!window.confirm(`Delete "${nodePath}"? This cannot be undone.`)) return;
    await fetch(`${apiBaseUrl}/fs/file?path=${encodeURIComponent(nodePath)}`, { method: "DELETE" });
    reload();
  }

  function renderNode(node: FsTreeNode, depth: number): JSX.Element {
    const isDir = node.kind === "directory";
    const isOpen = expanded.has(node.path);
    const isRoot = node.path === "";

    return (
      <div key={node.path || "/"}>
        <div
          style={{
            paddingLeft: depth * 14 + 4,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            background: node.path === activePath ? "#2a2d34" : "transparent",
          }}
        >
          <span
            style={{ cursor: "pointer", flex: 1 }}
            onClick={() => (isDir ? toggleDir(node.path) : onSelectFile(node.path))}
          >
            {isDir ? (isOpen ? "\u{1F4C2}" : "\u{1F4C1}") : "\u{1F4C4}"} {node.name}
          </span>
          {!isRoot && (
            <span style={{ display: "flex", gap: 4 }}>
              <button onClick={() => handleRename(node.path)} title="Rename">
                ✎
              </button>
              <button onClick={() => handleDelete(node.path)} title="Delete">
                🗑
              </button>
            </span>
          )}
        </div>
        {isDir && isOpen && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", color: "#ddd" }}>
      <div style={{ display: "flex", gap: 6, padding: "4px 4px 8px" }}>
        <button onClick={() => handleCreate("file")}>+ File</button>
        <button onClick={() => handleCreate("directory")}>+ Folder</button>
      </div>
      {error && <div style={{ color: "crimson", fontSize: 12, padding: 4 }}>{error}</div>}
      {root ? renderNode(root, 0) : <div style={{ fontSize: 12, padding: 4 }}>Loading...</div>}
    </div>
  );
}
