export type FsEntryKind = "file" | "directory";

/** Minimal reference to a filesystem entry: enough to identify it on the wire. */
export interface FsEntryRef {
  readonly path: string;
  readonly kind: FsEntryKind;
}

/** A full directory tree node, as returned by GET /fs/tree. */
export interface FsTreeNode {
  readonly name: string;
  /** Relative to the workspace root, forward-slash separated (e.g. "src/index.ts"). Root node's path is "". */
  readonly path: string;
  readonly kind: FsEntryKind;
  /** Present only for directories. */
  readonly children?: readonly FsTreeNode[];
}

/**
 * A single filesystem change, broadcast over the sandbox-agent's
 * `/fs/events` websocket. `create`/`update`/`delete` may originate either
 * from the File API or from the raw filesystem watcher (e.g. a terminal
 * command); `rename` is only ever emitted explicitly by the File API,
 * since a passive fs watcher generally can't distinguish a rename from an
 * unrelated delete+create pair.
 */
export type FsChangeEvent =
  | { readonly type: "create"; readonly entry: FsEntryRef }
  | { readonly type: "update"; readonly entry: FsEntryRef }
  | { readonly type: "delete"; readonly entry: FsEntryRef }
  | { readonly type: "rename"; readonly from: FsEntryRef; readonly to: FsEntryRef };

// ---- REST request/response DTOs for the File API ----

export interface CreateFileRequest {
  readonly path: string;
  readonly kind: FsEntryKind;
  /** Ignored for directories. Defaults to empty string for new files. */
  readonly content?: string;
}

export interface UpdateFileRequest {
  readonly path: string;
  readonly content: string;
}

export interface RenameFileRequest {
  readonly fromPath: string;
  readonly toPath: string;
}

export interface DeleteFileRequest {
  readonly path: string;
}

export interface ReadFileResponse {
  readonly path: string;
  readonly content: string;
}

export interface FsErrorResponse {
  readonly error: string;
}
