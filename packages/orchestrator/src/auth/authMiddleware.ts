import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { SessionRecord, SessionStore } from "../sessionStore/sessionStore.js";
import { ApiError, type Logger } from "../sessionStore/sessionTypes.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Account ids are embedded in sessions and tokens. No ":" so they can never equal ORPHAN_OWNER_ID. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** One account. `passwordHash` is the output of hashPassword(), never a password. */
export interface AuthUser {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
}

/** The authenticated caller, as handlers see it. */
export interface Principal {
  readonly userId: string;
  readonly username: string;
}

/** Principal used when auth is disabled. Loopback-only; see loadConfig. */
export const ANONYMOUS_PRINCIPAL: Principal = { userId: "dev-anonymous", username: "dev-anonymous" };

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: { readonly id: string; readonly username: string };
}

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt)                                           */
/* ------------------------------------------------------------------ */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

/**
 * Hashes a password for storage in ORCHESTRATOR_AUTH_USERS.
 * Format: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>`. The parameters
 * travel with the hash, so they can be raised later without invalidating
 * existing accounts.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), derived.toString("base64")].join("$");
}

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parsePasswordHash(stored: string): ParsedHash | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return undefined;
  }
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  if (![nRaw, rRaw, pRaw].every((value) => /^\d{1,8}$/.test(value))) {
    return undefined;
  }
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // Bounds keep a bad config entry from turning every login into a memory/CPU bomb.
  const nIsPowerOfTwo = n > 0 && (n & (n - 1)) === 0;
  if (!nIsPowerOfTwo || n < 1024 || n > 131_072 || r < 1 || r > 16 || p < 1 || p > 4) {
    return undefined;
  }
  const salt = Buffer.from(saltRaw, "base64");
  const hash = Buffer.from(hashRaw, "base64");
  if (salt.length < 8 || salt.length > 64 || hash.length < 16 || hash.length > 64) {
    return undefined;
  }
  return { n, r, p, salt, hash };
}

/** True when `stored` is a well-formed hashPassword() output. */
export function isWellFormedPasswordHash(stored: string): boolean {
  return parsePasswordHash(stored) !== undefined;
}

/** Constant-time password check. A malformed stored hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) {
    return false;
  }
  const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  return timingSafeEqual(derived, parsed.hash);
}

/* ------------------------------------------------------------------ */
/* User directory parsing                                              */
/* ------------------------------------------------------------------ */

export interface ParsedUsers {
  readonly users: readonly AuthUser[];
  readonly problems: readonly string[];
}

/**
 * Parses ORCHESTRATOR_AUTH_USERS: a JSON array of
 * `{ "id": "u_alice", "username": "alice", "passwordHash": "scrypt$..." }`.
 * Reports every problem found rather than the first.
 */
export function parseAuthUsers(raw: string): ParsedUsers {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { users: [], problems: ["ORCHESTRATOR_AUTH_USERS is not valid JSON"] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { users: [], problems: ["ORCHESTRATOR_AUTH_USERS must be a non-empty JSON array"] };
  }

  const users: AuthUser[] = [];
  const ids = new Set<string>();
  const usernames = new Set<string>();

  (parsed as unknown[]).forEach((entry, index) => {
    const label = `ORCHESTRATOR_AUTH_USERS[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${label} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const username = record["username"];
    const passwordHash = record["passwordHash"];

    if (typeof id !== "string" || !USER_ID_PATTERN.test(id)) {
      problems.push(`${label}.id must match ${USER_ID_PATTERN} (letters, digits, "_" and "-" only)`);
      return;
    }
    if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
      problems.push(`${label}.username must match ${USERNAME_PATTERN}`);
      return;
    }
    if (typeof passwordHash !== "string" || !isWellFormedPasswordHash(passwordHash)) {
      problems.push(`${label}.passwordHash must be a scrypt hash produced by hashPassword()`);
      return;
    }
    if (ids.has(id)) {
      problems.push(`${label}.id "${id}" is used twice`);
      return;
    }
    if (usernames.has(username.toLowerCase())) {
      problems.push(`${label}.username "${username}" is used twice (usernames are case-insensitive)`);
      return;
    }
    ids.add(id);
    usernames.add(username.toLowerCase());
    users.push({ id, username, passwordHash });
  });

  return { users: problems.length === 0 ? users : [], problems };
}

/* ------------------------------------------------------------------ */
/* Signed tokens                                                       */
/* ------------------------------------------------------------------ */

interface TokenClaims {
  readonly sub: string;
  readonly usr: string;
  readonly iat: number;
  readonly exp: number;
}

const TOKEN_VERSION = "v1";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * Stateless bearer tokens: `v1.<payload>.<signature>`, where the payload is
 * base64url JSON `{ sub, usr, iat, exp }` and the signature is
 * HMAC-SHA256(secret, "v1." + payload). The algorithm is fixed by the version
 * prefix, so there is nothing for a caller to downgrade. Tokens cannot be
 * revoked individually; they expire, and removing an account from the
 * directory invalidates its tokens immediately (see Authenticator.authenticate).
 */
export class TokenService {
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(secret: string, ttlMs: number, now: () => number) {
    this.secret = Buffer.from(secret, "utf8");
    this.ttlMs = ttlMs;
    this.now = now;
  }

  issue(user: Pick<AuthUser, "id" | "username">): { token: string; expiresAt: number } {
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.ttlMs;
    const claims: TokenClaims = { sub: user.id, usr: user.username, iat: issuedAt, exp: expiresAt };
    const payload = base64Url(Buffer.from(JSON.stringify(claims), "utf8"));
    return { token: `${TOKEN_VERSION}.${payload}.${this.sign(payload)}`, expiresAt };
  }

  /** Returns the claims of a genuine, unexpired token, or undefined. Never throws. */
  verify(token: string): TokenClaims | undefined {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
      return undefined;
    }
    const [, payload, signature] = parts as [string, string, string];

    const expected = Buffer.from(this.sign(payload), "utf8");
    const actual = Buffer.from(signature, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return undefined;
    }

    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (typeof claims !== "object" || claims === null) {
      return undefined;
    }
    const { sub, usr, iat, exp } = claims as Record<string, unknown>;
    if (
      typeof sub !== "string" ||
      !USER_ID_PATTERN.test(sub) ||
      typeof usr !== "string" ||
      typeof iat !== "number" ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp <= this.now()
    ) {
      return undefined;
    }
    return { sub, usr, iat, exp };
  }

  private sign(payload: string): string {
    return base64Url(createHmac("sha256", this.secret).update(`${TOKEN_VERSION}.${payload}`).digest());
  }
}

/* ------------------------------------------------------------------ */
/* Login throttling                                                    */
/* ------------------------------------------------------------------ */

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_TRACKED_KEYS_MAX = 10_000;

interface FailureWindow {
  count: number;
  windowStartedAt: number;
}

/**
 * Limits password guessing: after 5 failures within 5 minutes for the same
 * (client address, username) pair, further attempts get 429 until the window
 * ends. Keyed on the pair, not the username alone, so a stranger cannot lock a
 * real user out. In-memory and per-process; Phase 8's multi-replica setup
 * should move this to Redis.
 */
class LoginThrottle {
  private readonly failures = new Map<string, FailureWindow>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  assertAllowed(key: string): void {
    const entry = this.failures.get(key);
    if (!entry) {
      return;
    }
    if (this.now() - entry.windowStartedAt >= LOGIN_WINDOW_MS) {
      this.failures.delete(key);
      return;
    }
    if (entry.count >= LOGIN_MAX_FAILURES) {
      throw new ApiError(429, "too_many_attempts", "Too many failed sign-in attempts; try again in a few minutes");
    }
  }

  recordFailure(key: string): void {
    const current = this.now();
    const entry = this.failures.get(key);
    if (!entry || current - entry.windowStartedAt >= LOGIN_WINDOW_MS) {
      this.failures.set(key, { count: 1, windowStartedAt: current });
    } else {
      entry.count += 1;
    }
    if (this.failures.size > LOGIN_TRACKED_KEYS_MAX) {
      this.evict(current);
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  private evict(current: number): void {
    for (const [key, entry] of this.failures) {
      if (current - entry.windowStartedAt >= LOGIN_WINDOW_MS) {
        this.failures.delete(key);
      }
    }
    // Still over the cap: an attack with many distinct keys. Drop the oldest.
    while (this.failures.size > LOGIN_TRACKED_KEYS_MAX) {
      const oldest = this.failures.keys().next();
      if (oldest.done) {
        break;
      }
      this.failures.delete(oldest.value);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Authenticator                                                       */
/* ------------------------------------------------------------------ */

export type AuthSettings =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "required";
      readonly secret: string;
      readonly users: readonly AuthUser[];
      readonly tokenTtlMs: number;
    };

export interface AuthenticatorOptions {
  readonly settings: AuthSettings;
  readonly logger: Logger;
  readonly now: () => number;
}

function unauthorized(message: string): ApiError {
  return new ApiError(401, "unauthorized", message);
}

/**
 * Authenticates API requests and signs users in.
 *
 * In "required" mode every protected route needs `Authorization: Bearer
 * <token>` from POST /api/auth/login; anything else is a 401. In "disabled"
 * mode (loopback development only, enforced by loadConfig) every caller is
 * ANONYMOUS_PRINCIPAL, which still owns whatever it creates, so the ownership
 * logic is exercised identically in both modes.
 */
export class Authenticator {
  private readonly settings: AuthSettings;
  private readonly logger: Logger;
  private readonly tokens: TokenService | undefined;
  private readonly usersById = new Map<string, AuthUser>();
  private readonly usersByName = new Map<string, AuthUser>();
  private readonly throttle: LoginThrottle;
  /** A real hash to verify against when the username is unknown, so both paths cost the same. */
  private dummyHash: Promise<string> | undefined;

  constructor(options: AuthenticatorOptions) {
    this.settings = options.settings;
    this.logger = options.logger;
    this.throttle = new LoginThrottle(options.now);
    if (options.settings.mode === "required") {
      this.tokens = new TokenService(options.settings.secret, options.settings.tokenTtlMs, options.now);
      for (const user of options.settings.users) {
        this.usersById.set(user.id, user);
        this.usersByName.set(user.username.toLowerCase(), user);
      }
    }
  }

  get enabled(): boolean {
    return this.settings.mode === "required";
  }

  /** Verifies credentials and returns a token. Always the same 401 for unknown user and wrong password. */
  async login(username: string, password: string, clientKey: string): Promise<LoginResult> {
    if (!this.tokens) {
      throw new ApiError(404, "auth_disabled", "Authentication is disabled on this orchestrator");
    }

    const throttleKey = `${clientKey}|${username.toLowerCase()}`;
    this.throttle.assertAllowed(throttleKey);

    const user = this.usersByName.get(username.toLowerCase());
    this.dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    const passwordMatches = await verifyPassword(password, user ? user.passwordHash : await this.dummyHash);

    if (!user || !passwordMatches) {
      this.throttle.recordFailure(throttleKey);
      this.logger.warn("auth.login_failed", { clientKey });
      throw unauthorized("Invalid username or password");
    }

    this.throttle.recordSuccess(throttleKey);
    const { token, expiresAt } = this.tokens.issue(user);
    this.logger.info("auth.login", { userId: user.id });
    return { token, expiresAt, user: { id: user.id, username: user.username } };
  }

  /** Resolves the caller of a protected request, or throws a 401. */
  authenticate(req: IncomingMessage): Principal {
    if (!this.tokens) {
      return ANONYMOUS_PRINCIPAL;
    }

    const header = req.headers.authorization;
    if (header === undefined || header.length === 0) {
      throw unauthorized("Authentication required");
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) {
      throw unauthorized("Authorization header must be: Bearer <token>");
    }

    const claims = this.tokens.verify(match[1]);
    if (!claims) {
      throw unauthorized("Invalid or expired token");
    }
    // The account may have been removed since the token was issued.
    const user = this.usersById.get(claims.sub);
    if (!user) {
      throw unauthorized("Invalid or expired token");
    }
    return { userId: user.id, username: user.username };
  }
}

/** Identifies the remote peer for login throttling. */
export function clientKeyFromRequest(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/* ------------------------------------------------------------------ */
/* Ownership                                                           */
/* ------------------------------------------------------------------ */

/**
 * Returns the record only if `principal` owns it. A session that does not
 * exist and a session someone else owns produce the identical 404, so a
 * caller cannot probe which session ids are real.
 */
export function requireOwnedSession(
  record: SessionRecord | undefined,
  principal: Principal,
  sessionId: string,
): SessionRecord {
  if (!record || record.ownerId !== principal.userId) {
    throw new ApiError(404, "session_not_found", `No session with id "${sessionId}"`);
  }
  return record;
}

/** Loads a session by id and enforces ownership in one step. */
export async function loadOwnedSession(
  store: Pick<SessionStore, "get">,
  sessionId: string,
  principal: Principal,
): Promise<SessionRecord> {
  return requireOwnedSession(await store.get(sessionId), principal, sessionId);
}