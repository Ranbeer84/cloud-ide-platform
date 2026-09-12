import { useEffect, useRef, useState } from "react";
import type { Session, SessionState } from "@live/shared-types";
import { getSocket } from "../shared/socketClient";

export function HostPage(): JSX.Element {
  const [topic, setTopic] = useState("");
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
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

  function handleCreate(): void {
    if (!topic.trim()) {
      setError("Enter a topic before creating a session.");
      return;
    }
    const socket = getSocket();
    socket.emit("session:create", { topic: topic.trim() }, (ack) => {
      if (ack.ok) {
        sessionIdRef.current = ack.session.id;
        setSession(ack.session);
        setError(undefined);
      } else {
        setError(ack.error);
      }
    });
  }

  function handleSetState(next: SessionState): void {
    if (!session) return;
    const socket = getSocket();
    socket.emit(
      "session:update",
      { sessionId: session.id, patch: { state: next } },
      (ack) => {
        if (ack.ok) {
          setSession(ack.session);
        } else {
          setError(ack.error);
        }
      },
    );
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
      <h1>Host a Session</h1>

      {!session && (
        <div>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Session topic"
            style={{ padding: "0.5rem", width: "100%", marginBottom: "0.5rem" }}
          />
          <button onClick={handleCreate}>Create session</button>
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

      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
