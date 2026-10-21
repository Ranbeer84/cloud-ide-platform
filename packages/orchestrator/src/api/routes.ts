import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ApiError,
  toSessionView,
  type ApiContext,
  type HeartbeatResponse,
} from "../sessionStore/sessionTypes.js";
import { createSession } from "./createSession.js";
import { endSession } from "./endSession.js";

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Route =
  | { readonly name: "health" }
  | { readonly name: "createSession" }
  | { readonly name: "listSessions" }
  | { readonly name: "getSession"; readonly sessionId: string }
  | { readonly name: "heartbeat"; readonly sessionId: string }
  | { readonly name: "endSession"; readonly sessionId: string };

interface RouteMatch {
  /** The route to run, or undefined if the path exists but not for this method. */
  readonly route: Route | undefined;
  /** Methods the path supports (used for 405 responses). */
  readonly allowed: readonly string[];
}

/**
 * Maps method + path onto a route. Returns undefined when the path is
 * unknown (404); returns `route: undefined` with `allowed` when the path is
 * known but the method is not (405).
 */
function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (path === "/healthz") {
    return { route: method === "GET" ? { name: "health" } : undefined, allowed: ["GET"] };
  }

  if (path === "/api/sessions") {
    if (method === "POST") {
      return { route: { name: "createSession" }, allowed: ["GET", "POST"] };
    }
    if (method === "GET") {
      return { route: { name: "listSessions" }, allowed: ["GET", "POST"] };
    }
    return { route: undefined, allowed: ["GET", "POST"] };
  }

  const heartbeat = /^\/api\/sessions\/([^/]+)\/heartbeat$/.exec(path);
  if (heartbeat?.[1] !== undefined) {
    const sessionId = decodeSessionId(heartbeat[1]);
    if (sessionId === undefined) {
      return undefined;
    }
    return {
      route: method === "POST" ? { name: "heartbeat", sessionId } : undefined,
      allowed: ["POST"],
    };
  }

  const single = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (single?.[1] !== undefined) {
    const sessionId = decodeSessionId(single[1]);
    if (sessionId === undefined) {
      return undefined;
    }
    if (method === "GET") {
      return { route: { name: "getSession", sessionId }, allowed: ["GET", "DELETE"] };
    }
    if (method === "DELETE") {
      return { route: { name: "endSession", sessionId }, allowed: ["GET", "DELETE"] };
    }
    return { route: undefined, allowed: ["GET", "DELETE"] };
  }

  return undefined;
}

function decodeSessionId(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return SESSION_ID_PATTERN.test(decoded) ? decoded : undefined;
}

function applyCors(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const { allowedOrigin } = ctx.config;

  res.setHeader("Vary", "Origin");
  if (allowedOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin !== undefined && origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

/**
 * Reads an optional JSON object body. An empty body is `{}`; anything that
 * is not a JSON object, or is larger than MAX_BODY_BYTES, is rejected.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, "body_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_body", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function dispatch(ctx: ApiContext, route: Route, req: IncomingMessage, res: ServerResponse): Promise<number> {
  switch (route.name) {
    case "health": {
      const redisOk = await ctx.store.ping();
      const status = redisOk ? 200 : 503;
      sendJson(res, status, { status: redisOk ? "ok" : "degraded", redis: redisOk, time: ctx.now() });
      return status;
    }

    case "createSession": {
      await readJsonBody(req);
      const created = await createSession(ctx);
      sendJson(res, 201, created);
      return 201;
    }

    case "listSessions": {
      const records = await ctx.store.list();
      sendJson(res, 200, { sessions: records.map((record) => toSessionView(record, ctx.config)) });
      return 200;
    }

    case "getSession": {
      const record = await ctx.store.get(route.sessionId);
      if (!record) {
        throw new ApiError(404, "session_not_found", `No session with id "${route.sessionId}"`);
      }
      sendJson(res, 200, toSessionView(record, ctx.config));
      return 200;
    }

    case "heartbeat": {
      const at = ctx.now();
      const exists = await ctx.store.touch(route.sessionId, at);
      if (!exists) {
        throw new ApiError(404, "session_not_found", `No session with id "${route.sessionId}"`);
      }
      const body: HeartbeatResponse = { sessionId: route.sessionId, lastActivityAt: at };
      sendJson(res, 200, body);
      return 200;
    }

    case "endSession": {
      const ended = await endSession(ctx, route.sessionId);
      sendJson(res, 200, ended);
      return 200;
    }
  }
}

async function handle(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = ctx.now();
  const method = (req.method ?? "GET").toUpperCase();
  let pathname = req.url ?? "/";
  let status = 500;

  try {
    applyCors(ctx, req, res);

    pathname = new URL(req.url ?? "/", "http://orchestrator.local").pathname;

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      status = 204;
      return;
    }

    const match = matchRoute(method, pathname);
    if (!match) {
      throw new ApiError(404, "not_found", `No route for ${method} ${pathname}`);
    }
    if (!match.route) {
      status = 405;
      sendJson(
        res,
        405,
        { error: { code: "method_not_allowed", message: `${method} is not allowed on ${pathname}` } },
        { Allow: match.allowed.join(", ") },
      );
      return;
    }

    status = await dispatch(ctx, match.route, req, res);
  } catch (error) {
    if (error instanceof ApiError) {
      status = error.status;
      if (!res.headersSent) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      }
    } else {
      status = 500;
      ctx.logger.error("request.unhandled_error", {
        method,
        pathname,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: "internal_error", message: "Internal server error" } });
      }
    }
  } finally {
    ctx.logger.info("request", { method, pathname, status, durationMs: ctx.now() - startedAt });
  }
}

/**
 * Builds the node:http request listener for the orchestrator API.
 *
 *   GET    /healthz                       liveness + Redis connectivity
 *   POST   /api/sessions                  spawn a sandbox, register the session
 *   GET    /api/sessions                  list sessions
 *   GET    /api/sessions/:id              one session
 *   POST   /api/sessions/:id/heartbeat    record activity (resets the idle clock)
 *   DELETE /api/sessions/:id              tear the session down
 */
export function createRequestHandler(ctx: ApiContext): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(ctx, req, res);
  };
}