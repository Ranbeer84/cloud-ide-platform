import { useEffect, useRef, useState } from "react";
import type { Session, SessionState } from "@live/shared-types";
import { useAuth } from "../auth/AuthContext";
import { RequireAuth } from "../auth/Login";
import { getSocket } from "../shared/socketClient";

/** How often the host tells the orchestrator the sandbox is still in use. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Consecutive failed heartbeats before the person is warned. */
const HEARTBEAT_FAILURES_BEFORE_WARNING = 3;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The sandbox session id when this page was opened from an orchestrator hostUrl (`/host?session=...`). */
function readSandboxSessionFromUrl(): string | undefined {
  const value = new URLSearchParams(window.location.search).get("session");
  return value !== null && SESSION_ID_PATTERN.test(value) ? value : undefined;
}

function readStringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

async function describeFailure(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = readStringField(body, "message") ?? readStringField(body, "error");
    return message ? `${fallback}: ${message}` : `${fallback} (HTTP ${response.status}).`;
  } catch {
    return `${fallback} (HTTP ${response.status}).`;
  }
}

/** The host screen. Everything on it needs a signed-in account (or auth disabled in development). */
export function HostPage(): JSX.Element {
  return (
    <RequireAuth>
      <HostInterface />
    </RequireAuth>
  );
}

function HostInterface(): JSX.Element {
  const { authFetch, user, logout } = useAuth();
  const [topic, setTopic] = useState("");
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** The orchestrator's sandbox session. Its heartbeat keeps the idle reaper away. */
  const [sandboxId, setSandboxId] = useState<string | undefined>(readSandboxSessionFromUrl);
  const [heartbeatProblem, setHeartbeatProblem] = useState<string | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const socket = getSocket();
    socket.on("session:state", (updated) => {
      if (updated.id === sessionIdRef.current) {
        setSession(updated);
      }
    });
    socket.on("session:error", (payload) => setError(payload.message));
    return () => {
      socket.off("session:state");
      socket.off("session:error");
    };
  }, []);

  // Heartbeat: POST /api/sessions/:id/heartbeat now and then every 30 seconds
  // for as long as the page holds a sandbox. The orchestrator reaps sandboxes
  // that stay silent past its idle timeout, so a host who is only watching
  // (no typing) must not lose the sandbox.
  useEffect(() => {
    if (sandboxId === undefined) {
      return undefined;
    }
    const target = `/api/sessions/${encodeURIComponent(sandboxId)}/heartbeat`;
    let cancelled = false;
    let consecutiveFailures = 0;
    let timer: number | undefined;

    const stop = (): void => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const beat = async (): Promise<void> => {
      let failed = false;
      try {
        const response = await authFetch(target, { method: "POST" });
        if (cancelled) {
          return;
        }
        if (response.ok) {
          consecutiveFailures = 0;
          setHeartbeatProblem(undefined);
          return;
        }
        if (response.status === 404) {
          stop();
          setHeartbeatProblem("The sandbox no longer exists: it was ended or timed out.");
          return;
        }
        if (response.status === 401) {
          // authFetch has already signed the person out; RequireAuth shows the sign-in form.
          stop();
          return;
        }
        failed = true;
      } catch {
        failed = true;
      }
      if (cancelled || !failed) {
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= HEARTBEAT_FAILURES_BEFORE_WARNING) {
        setHeartbeatProblem("Cannot reach the orchestrator. The sandbox may be shut down if this continues.");
      }
    };

    void beat();
    timer = window.setInterval(() => {
      void beat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      stop();
    };
  }, [sandboxId, authFetch]);

  async function ensureSandbox(): Promise<string | undefined> {
    if (sandboxId !== undefined) {
      return sandboxId;
    }
    const response = await authFetch("/api/sessions", { method: "POST" });
    if (!response.ok) {
      if (response.status !== 401) {
        setError(await describeFailure(response, "Could not start a sandbox"));
      }
      return undefined;
    }
    const created = readStringField(await response.json(), "sessionId");
    if (created === undefined) {
      setError("The orchestrator returned an unexpected response.");
      return undefined;
    }
    setSandboxId(created);
    return created;
  }

  async function handleCreate(): Promise<void> {
    if (!topic.trim()) {
      setError("Enter a topic before creating a session.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const sandbox = await ensureSandbox();
      if (sandbox === undefined) {
        return;
      }
      getSocket().emit("session:create", { topic: topic.trim() }, (ack) => {
        if (ack.ok) {
          sessionIdRef.current = ack.session.id;
          setSession(ack.session);
          setError(undefined);
        } else {
          setError(ack.error);
        }
      });
    } catch {
      setError("Could not reach the orchestrator. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function endSandbox(): void {
    const id = sandboxId;
    if (id === undefined) {
      return;
    }
    setSandboxId(undefined);
    setHeartbeatProblem(undefined);
    authFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {
      // Best effort: anything left behind is reaped when the heartbeat stops.
    });
  }

  function handleSetState(next: SessionState): void {
    if (!session) return;
    getSocket().emit(
      "session:update",
      { sessionId: session.id, patch: { state: next } },
      (ack) => {
        if (ack.ok) {
          setSession(ack.session);
          if (next === "ended") {
            endSandbox();
          }
        } else {
          setError(ack.error);
        }
      },
    );
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
      <p style={{ textAlign: "right", fontSize: "0.85rem" }}>
        {user ? `Signed in as ${user.username} ` : null}
        <button onClick={logout}>Sign out</button>
      </p>
      <h1>Host a Session</h1>

      {!session && (
        <div>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Session topic"
            style={{ padding: "0.5rem", width: "100%", marginBottom: "0.5rem" }}
          />
          <button onClick={() => void handleCreate()} disabled={busy}>
            {busy ? "Starting…" : "Create session"}
          </button>
        </div>
      )}

      {session && (
        <div>
          <p>
            Share this code with viewers: <strong style={{ fontSize: "1.5rem" }}>{session.code}</strong>
          </p>
          <p>Topic: {session.topic}</p>
          <p>State: {session.state}</p>
          <p>Viewers connected: {session.viewerCount}</p>
          {sandboxId !== undefined && <p>Sandbox: {sandboxId}</p>}
          <button
            onClick={() => handleSetState("live")}
            disabled={session.state === "live"}
          >
            Go live
          </button>{" "}
          <button
            onClick={() => handleSetState("ended")}
            disabled={session.state === "ended"}
          >
            End session
          </button>
        </div>
      )}

      {heartbeatProblem && <p style={{ color: "darkorange" }}>{heartbeatProblem}</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}