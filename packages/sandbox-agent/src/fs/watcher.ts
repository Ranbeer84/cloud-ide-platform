import chokidar from "chokidar";
import path from "node:path";
import type { FsChangeEvent, FsEntryKind } from "./types.js";

const IGNORED_GLOBS = [/(^|[/\\])\.git([/\\]|$)/, /(^|[/\\])node_modules([/\\]|$)/];

function toWireRelative(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

export interface FsWatcherOptions {
  readonly rootDir: string;
  readonly onChange: (event: FsChangeEvent) => void;
}

/**
 * Watches the sandbox workspace for filesystem changes made outside the
 * File API -- most notably, commands run directly in the terminal
 * (`touch`, `rm`, `mv`, a build tool writing output, etc). Changes are
 * reported through the same FsChangeEvent shape the File API emits, so
 * every client only has to understand one event contract regardless of
 * how a change originated.
 *
 * Renames are intentionally not synthesized here: chokidar (like every
 * OS-level watcher) reports a rename as an unrelated unlink+add pair, and
 * guessing at a from/to relationship from timing is unreliable. Semantic
 * renames are only ever emitted by the File API's explicit /fs/rename
 * route, which knows the relationship directly.
 */
export class FsWatcher {
  private readonly rootDir: string;
  private readonly onChange: (event: FsChangeEvent) => void;
  private watcher: ReturnType<typeof chokidar.watch> | undefined;

  constructor(options: FsWatcherOptions) {
    this.rootDir = options.rootDir;
    this.onChange = options.onChange;
  }

  start(): void {
    this.watcher = chokidar.watch(this.rootDir, {
      ignored: IGNORED_GLOBS,
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher
      .on("add", (filePath: string) => this.emit("create", filePath, "file"))
      .on("addDir", (dirPath: string) => this.emit("create", dirPath, "directory"))
      .on("change", (filePath: string) => this.emit("update", filePath, "file"))
      .on("unlink", (filePath: string) => this.emit("delete", filePath, "file"))
      .on("unlinkDir", (dirPath: string) => this.emit("delete", dirPath, "directory"));
  }

  private emit(type: "create" | "update" | "delete", absolutePath: string, kind: FsEntryKind): void {
    const relativePath = toWireRelative(this.rootDir, absolutePath);
    if (relativePath === "" || relativePath.startsWith("..")) {
      return;
    }
    this.onChange({ type, entry: { path: relativePath, kind } });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
