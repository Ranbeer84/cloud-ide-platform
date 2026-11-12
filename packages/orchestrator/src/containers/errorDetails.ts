/**
 * Helpers for reporting and classifying Docker / containerd / runsc failures.
 *
 * dockerode (docker-modem) errors carry more than `message`: the HTTP
 * `statusCode`, a `reason`, and the daemon's own text in `json.message`
 * (this is where "OCI runtime create failed: ..." from runsc ends up).
 * Logging only `error.message` loses most of that.
 */

const MAX_STACK_LINES = 6;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Structured, log-safe description of any thrown value. Never throws. */
export function describeError(error: unknown): Record<string, unknown> {
  const fields = asRecord(error);
  const json = asRecord(fields["json"]);
  const details: Record<string, unknown> = {
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof Error) {
    details["errorName"] = error.name;
    if (error.stack) {
      details["stack"] = error.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n");
    }
  }
  for (const key of ["statusCode", "reason", "code", "errno", "syscall"]) {
    if (fields[key] !== undefined) {
      details[key] = fields[key];
    }
  }
  if (typeof json["message"] === "string") {
    details["daemonMessage"] = json["message"];
  }
  return details;
}

function fullText(error: unknown): string {
  const details = describeError(error);
  return [details["message"], details["daemonMessage"], details["reason"]]
    .filter((part): part is string => typeof part === "string")
    .join(" | ");
}

/** Failures that retrying with a fresh session id cannot fix. Checked first. */
const PERMANENT_PATTERNS: readonly RegExp[] = [
  /no such image|pull access denied|manifest .* not found|repository does not exist/i,
  /unknown or invalid runtime|runtime .* not registered|is running under/i,
  /pool overlaps|address pools? .*(exhaust|fully)|could not find an available, non-overlapping/i,
  /invalid reference format|invalid (?:memory|cpu|pids)|minimum memory limit/i,
];

/** Failures that come from concurrent container/network churn and normally clear on a second try. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /network .* not found|no such network/i,
  /port is already allocated|address already in use/i,
  /already exists in network|endpoint with name .* already exists/i,
  /resource temporarily unavailable|device or resource busy|try again/i,
  /container .* is not running|is marked for removal|removal of container .* is already in progress/i,
];

const TRANSIENT_SYSTEM_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);

export function isTransientSpawnError(error: unknown): boolean {
  const text = fullText(error);
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const details = describeError(error);
  if (typeof details["code"] === "string" && TRANSIENT_SYSTEM_CODES.has(details["code"])) {
    return true;
  }
  return details["statusCode"] === 409;
}
