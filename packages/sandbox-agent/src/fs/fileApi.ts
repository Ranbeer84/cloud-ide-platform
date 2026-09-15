import { Router, type Request, type Response } from "express";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { FsChangeEvent, FsEntryKind, FsTreeNode } from "./types.js";

/** Entries never shown in the tree or reachable through the API. */
const IGNORED_ENTRIES = new Set([".git", "node_modules"]);

export class PathTraversalError extends Error {
  constructor(attemptedPath: string) {
    super(`Path escapes workspace root: ${attemptedPath}`);
    this.name = "PathTraversalError";
  }
}

/**
 * Resolves a client-supplied relative path against rootDir, rejecting any
 * attempt to escape it (e.g. "../../etc/passwd"). This is the one chokepoint
 * every route below funnels user-supplied paths through.
 */
export function resolveSafePath(rootDir: string, relativePath: string): string {
  const normalized = path.normalize(relativePath ?? "").replace(/^([/\\])+/, "");
  const resolved = path.resolve(rootDir, normalized);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (resolved !== rootDir && !resolved.startsWith(rootWithSep)) {
    throw new PathTraversalError(relativePath);
  }
  return resolved;
}

function toWireRelative(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

async function buildTree(rootDir: string, currentDir: string): Promise<FsTreeNode> {
  const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
  const children: FsTreeNode[] = [];

  for (const entry of entries) {
    if (IGNORED_ENTRIES.has(entry.name)) {
      continue;
    }
    const absoluteChildPath = path.join(currentDir, entry.name);
    const relativeChildPath = toWireRelative(rootDir, absoluteChildPath);

    if (entry.isDirectory()) {
      children.push(await buildTree(rootDir, absoluteChildPath));
    } else if (entry.isFile()) {
      children.push({ name: entry.name, path: relativeChildPath, kind: "file" });
    }
  }

  children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    name: path.basename(currentDir) || "/",
    path: toWireRelative(rootDir, currentDir),
    kind: "directory",
    children,
  };
}

export interface CreateFileApiOptions {
  readonly rootDir: string;
  /** Called after every successful mutation so the server can broadcast it over /fs/events. */
  readonly onChange: (event: FsChangeEvent) => void;
}

export function createFileRouter({ rootDir, onChange }: CreateFileApiOptions): Router {
  const router = Router();

  router.get("/tree", async (_req: Request, res: Response) => {
    try {
      const tree = await buildTree(rootDir, rootDir);
      res.json(tree);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.get("/file", async (req: Request, res: Response) => {
    const relPath = String(req.query["path"] ?? "");
    try {
      const absolutePath = resolveSafePath(rootDir, relPath);
      const content = await fsPromises.readFile(absolutePath, "utf8");
      res.json({ path: relPath, content });
    } catch (error) {
      res.status(toStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  router.post("/file", async (req: Request, res: Response) => {
    const body = req.body as { path?: string; kind?: FsEntryKind; content?: string };
    if (!body.path || (body.kind !== "file" && body.kind !== "directory")) {
      res.status(400).json({ error: "Expected { path: string, kind: 'file' | 'directory' }" });
      return;
    }
    try {
      const absolutePath = resolveSafePath(rootDir, body.path);
      if (body.kind === "directory") {
        await fsPromises.mkdir(absolutePath, { recursive: true });
      } else {
        await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fsPromises.writeFile(absolutePath, body.content ?? "", "utf8");
      }
      onChange({ type: "create", entry: { path: body.path, kind: body.kind } });
      res.status(201).json({ path: body.path, kind: body.kind });
    } catch (error) {
      res.status(toStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  router.put("/file", async (req: Request, res: Response) => {
    const body = req.body as { path?: string; content?: string };
    if (!body.path || typeof body.content !== "string") {
      res.status(400).json({ error: "Expected { path: string, content: string }" });
      return;
    }
    try {
      const absolutePath = resolveSafePath(rootDir, body.path);
      await fsPromises.writeFile(absolutePath, body.content, "utf8");
      onChange({ type: "update", entry: { path: body.path, kind: "file" } });
      res.json({ path: body.path, content: body.content });
    } catch (error) {
      res.status(toStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  router.post("/rename", async (req: Request, res: Response) => {
    const body = req.body as { fromPath?: string; toPath?: string };
    if (!body.fromPath || !body.toPath) {
      res.status(400).json({ error: "Expected { fromPath: string, toPath: string }" });
      return;
    }
    try {
      const fromAbsolute = resolveSafePath(rootDir, body.fromPath);
      const toAbsolute = resolveSafePath(rootDir, body.toPath);
      const stat = await fsPromises.stat(fromAbsolute);
      const kind: FsEntryKind = stat.isDirectory() ? "directory" : "file";
      await fsPromises.mkdir(path.dirname(toAbsolute), { recursive: true });
      await fsPromises.rename(fromAbsolute, toAbsolute);
      onChange({
        type: "rename",
        from: { path: body.fromPath, kind },
        to: { path: body.toPath, kind },
      });
      res.json({ fromPath: body.fromPath, toPath: body.toPath });
    } catch (error) {
      res.status(toStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  router.delete("/file", async (req: Request, res: Response) => {
    const relPath = String(req.query["path"] ?? "");
    try {
      const absolutePath = resolveSafePath(rootDir, relPath);
      const stat = await fsPromises.stat(absolutePath);
      const kind: FsEntryKind = stat.isDirectory() ? "directory" : "file";
      await fsPromises.rm(absolutePath, { recursive: true, force: true });
      onChange({ type: "delete", entry: { path: relPath, kind } });
      res.json({ path: relPath });
    } catch (error) {
      res.status(toStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toStatusCode(error: unknown): number {
  if (error instanceof PathTraversalError) {
    return 400;
  }
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") {
    return 404;
  }
  return 500;
}
