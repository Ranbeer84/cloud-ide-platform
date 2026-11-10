import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const ORCHESTRATOR_URL = (
  (import.meta.env["VITE_ORCHESTRATOR_URL"] as string | undefined) ?? "http://127.0.0.1:4100"
).replace(/\/+$/, "");

/**
 * Where the token lives. sessionStorage is cleared when the tab closes and is
 * not shared between tabs, which limits how long a leaked token is useful.
 * Like any script-readable storage it is exposed to XSS, so the app must keep
 * its CSP strict and never render untrusted HTML.
 */
const STORAGE_KEY = "live.auth.v1";
const EXPIRY_CHECK_INTERVAL_MS = 30_000;

export interface AuthUser {
  readonly id: string;
  readonly username: string;
}

export type AuthStatus = "loading" | "signedOut" | "signedIn";

export type LoginFailure = "invalid" | "throttled" | "network" | "server";

/** Thrown by login(). `kind` is stable; `message` is safe to show to the person. */
export class LoginError extends Error {
  readonly kind: LoginFailure;

  constructor(kind: LoginFailure, message: string) {
    super(message);
    this.name = "LoginError";
    this.kind = kind;
  }
}

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: AuthUser | undefined;
  /** False when the orchestrator runs with authentication disabled (development). */
  readonly authEnabled: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): void;
  /**
   * fetch() against the orchestrator, with the bearer token attached.
   * `path` is relative to the orchestrator, e.g. "/api/sessions". A 401
   * response signs the person out, so a revoked or expired token cannot leave
   * the UI stuck in a signed-in state.
   */
  authFetch(path: string, init?: RequestInit): Promise<Response>;
}

interface StoredAuth {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: AuthUser;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function isAuthUser(value: unknown): value is AuthUser {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" && typeof candidate["username"] === "string";
}

function readStored(): StoredAuth | undefined {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Record<string, unknown>;
    const token = candidate["token"];
    const expiresAt = candidate["expiresAt"];
    const user = candidate["user"];
    if (typeof token !== "string" || typeof expiresAt !== "number" || !isAuthUser(user)) {
      return undefined;
    }
    return { token, expiresAt, user };
  } catch {
    return undefined;
  }
}

function writeStored(value: StoredAuth | undefined): void {
  try {
    if (value) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode, blocked). The session then lasts until reload.
  }
}

interface AuthState {
  readonly status: AuthStatus;
  readonly user: AuthUser | undefined;
  readonly authEnabled: boolean;
}

const INITIAL_STATE: AuthState = { status: "loading", user: undefined, authEnabled: true };

export function AuthProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);
  // The token is read at call time through a ref, so authFetch keeps a stable identity.
  const authRef = useRef<StoredAuth | undefined>(undefined);

  const signOut = useCallback((): void => {
    authRef.current = undefined;
    writeStored(undefined);
    setState({ status: "signedOut", user: undefined, authEnabled: true });
  }, []);

  const authFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      const current = authRef.current;
      if (current) {
        headers.set("Authorization", `Bearer ${current.token}`);
      }
      const response = await fetch(`${ORCHESTRATOR_URL}${path}`, { ...init, headers });
      if (response.status === 401 && current) {
        signOut();
      }
      return response;
    },
    [signOut],
  );

  // On load: reuse a stored token if it is still good, or detect that auth is off.
  useEffect(() => {
    let cancelled = false;

    async function restore(): Promise<void> {
      const stored = readStored();
      if (stored && stored.expiresAt <= Date.now()) {
        writeStored(undefined);
      } else if (stored) {
        authRef.current = stored;
      }

      try {
        const response = await authFetch("/api/auth/me");
        if (cancelled) {
          return;
        }
        if (response.ok) {
          const body = (await response.json()) as { user?: unknown; authEnabled?: unknown };
          if (isAuthUser(body.user)) {
            setState({ status: "signedIn", user: body.user, authEnabled: body.authEnabled !== false });
            return;
          }
        }
        signOut();
      } catch {
        if (cancelled) {
          return;
        }
        // The orchestrator is unreachable. Keep a stored sign-in rather than
        // logging the person out over a network blip; calls will fail until it is back.
        const kept = authRef.current;
        if (kept) {
          setState({ status: "signedIn", user: kept.user, authEnabled: true });
        } else {
          setState({ status: "signedOut", user: undefined, authEnabled: true });
        }
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [authFetch, signOut]);

  // Sign out when the token expires. A timer would overflow for long-lived
  // tokens (setTimeout caps near 24.8 days), so poll instead.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const current = authRef.current;
      if (current && current.expiresAt <= Date.now()) {
        signOut();
      }
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [signOut]);

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(`${ORCHESTRATOR_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      throw new LoginError("network", "Cannot reach the server. Check your connection and try again.");
    }

    if (response.status === 401) {
      throw new LoginError("invalid", "Invalid username or password.");
    }
    if (response.status === 429) {
      throw new LoginError("throttled", "Too many failed attempts. Wait a few minutes and try again.");
    }
    if (response.status === 400) {
      throw new LoginError("invalid", "Enter both a username and a password.");
    }
    if (!response.ok) {
      throw new LoginError("server", "The server could not sign you in. Try again shortly.");
    }

    const body = (await response.json()) as { token?: unknown; expiresAt?: unknown; user?: unknown };
    if (typeof body.token !== "string" || typeof body.expiresAt !== "number" || !isAuthUser(body.user)) {
      throw new LoginError("server", "The server sent an unexpected response.");
    }
    const stored: StoredAuth = { token: body.token, expiresAt: body.expiresAt, user: body.user };
    authRef.current = stored;
    writeStored(stored);
    setState({ status: "signedIn", user: stored.user, authEnabled: true });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.user,
      authEnabled: state.authEnabled,
      login,
      logout: signOut,
      authFetch,
    }),
    [state, login, signOut, authFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access auth state and actions. Must be used under <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return value;
}