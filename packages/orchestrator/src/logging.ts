import type { LogFields, Logger } from "./sessionStore/sessionTypes.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A Logger that also supports debug output and per-request / per-component context. */
export interface StructuredLogger extends Logger {
  debug(message: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every line it writes. */
  child(bindings: LogFields): StructuredLogger;
  isLevelEnabled(level: LogLevel): boolean;
}

/** Where finished lines go. The default writes info/debug to stdout and warn/error to stderr. */
export interface LogSink {
  write(level: LogLevel, line: string): void;
}

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 8_192;
const RESERVED_KEYS: ReadonlySet<string> = new Set(["ts", "level", "msg"]);

/** Keys whose values are never written to a log line. */
const SECRET_KEY_PATTERN =
  /(?:password|passwd|secret|authorization|cookie|api[-_]?key|private[-_]?key|credential)|(?:^|[-_])token$|[a-z]Token$/i;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export const defaultSink: LogSink = {
  write(level, line) {
    if (level === "debug" || level === "info") {
      process.stdout.write(`${line}\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  },
};

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]` : value;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case "string":
      return truncate(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  const object = value as object;
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  }
  if (Buffer.isBuffer(object)) {
    return `[Buffer ${object.length} bytes]`;
  }
  if (seen.has(object)) {
    return "[Circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[MaxDepth]";
  }
  seen.add(object);
  try {
    if (object instanceof Error) {
      const out: Record<string, unknown> = {
        name: object.name,
        message: truncate(object.message),
      };
      if (object.stack !== undefined) {
        out["stack"] = truncate(object.stack);
      }
      const code = (object as { code?: unknown }).code;
      if (typeof code === "string" || typeof code === "number") {
        out["code"] = code;
      }
      if (object.cause !== undefined) {
        out["cause"] = sanitize(object.cause, depth + 1, seen);
      }
      return out;
    }
    if (object instanceof Map) {
      return sanitize(Array.from(object.entries()), depth, seen);
    }
    if (object instanceof Set) {
      return sanitize(Array.from(object.values()), depth, seen);
    }
    if (Array.isArray(object)) {
      const items = object.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen));
      if (object.length > MAX_ARRAY_ITEMS) {
        items.push(`[${object.length - MAX_ARRAY_ITEMS} more items]`);
      }
      return items;
    }
    return sanitizeRecord(object as Record<string, unknown>, depth + 1, seen);
  } finally {
    seen.delete(object);
  }
}

function sanitizeRecord(record: Readonly<Record<string, unknown>>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    const clean = sanitize(value, depth, seen);
    if (clean !== undefined) {
      out[key] = clean;
    }
  }
  return out;
}

/**
 * Builds one JSON log line: `ts`, `level`, `msg`, then bindings, then fields.
 * Field names that collide with ts/level/msg are kept as `field_<name>`, so a
 * caller can never forge the envelope. Secret-looking keys are redacted at any depth.
 */
export function formatLogLine(level: LogLevel, message: string, bindings: LogFields, fields: LogFields | undefined, at: Date): string {
  const merged = sanitizeRecord({ ...bindings, ...(fields ?? {}) }, 0, new WeakSet());
  const record: Record<string, unknown> = { ts: at.toISOString(), level, msg: truncate(message) };
  for (const [key, value] of Object.entries(merged)) {
    record[RESERVED_KEYS.has(key) ? `field_${key}` : key] = value;
  }
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: record["ts"], level, msg: record["msg"], logError: "fields could not be serialized" });
  }
}

export function createLogger(options: CreateLoggerOptions = {}): StructuredLogger {
  const threshold = LEVEL_RANK[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): Date => new Date());
  const bindings: LogFields = options.bindings ?? {};

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < threshold) {
      return;
    }
    sink.write(level, formatLogLine(level, message, bindings, fields, now()));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    isLevelEnabled: (level) => LEVEL_RANK[level] >= threshold,
    child: (extra) =>
      createLogger({
        level: options.level ?? "info",
        bindings: { ...bindings, ...extra },
        sink,
        now,
      }),
  };
}

/**
 * Reads LOG_LEVEL (debug | info | warn | error, default info) and adds
 * `service: "orchestrator"` plus any extra bindings to every line. An invalid
 * LOG_LEVEL never stops the process from booting: it falls back to info and
 * says so on the first line.
 */
export function createLoggerFromEnv(env: Readonly<Record<string, string | undefined>>, bindings: LogFields = {}, sink?: LogSink): StructuredLogger {
  const raw = env["LOG_LEVEL"]?.trim().toLowerCase();
  const valid = raw !== undefined && raw !== "" && isLogLevel(raw);
  const logger = createLogger({
    level: valid ? raw : "info",
    bindings: { service: "orchestrator", ...bindings },
    ...(sink ? { sink } : {}),
  });
  if (raw !== undefined && raw !== "" && !valid) {
    logger.warn("logging.invalid_level", { value: raw, using: "info", allowed: LOG_LEVELS });
  }
  return logger;
}

/** Type guard: does this Logger also support debug output and child()? */
export function isStructuredLogger(logger: Logger): logger is StructuredLogger {
  const candidate = logger as Partial<StructuredLogger>;
  return typeof candidate.debug === "function" && typeof candidate.child === "function";
}

/** Writes at debug level when the logger supports it; otherwise writes nothing. */
export function logDebug(logger: Logger, message: string, fields?: LogFields): void {
  if (isStructuredLogger(logger)) {
    logger.debug(message, fields);
  }
}

/** Child logger with `bindings` when supported; otherwise the logger itself. */
export function withBindings(logger: Logger, bindings: LogFields): Logger {
  return isStructuredLogger(logger) ? logger.child(bindings) : logger;
}