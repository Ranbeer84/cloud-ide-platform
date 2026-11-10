import { useEffect, useRef, useState } from "react";
import type { Session } from "@live/shared-types";
import { getSocket } from "../shared/socketClient";

export function ViewerPage(): JSX.Element {
  const [code, setCode] = useState("");
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
    socket.on("session:ended", (payload) => {
      if (payload.sessionId === sessionIdRef.current) {
        setError("The host has ended this session.");
      }
    });
    return () => {
      socket.off("session:state");
      socket.off("session:ended");
    };
  }, []);

  function handleJoin(): void {
    if (!code.trim()) {
      setError("Enter a session code to join.");
      return;
    }
    const socket = getSocket();
    socket.emit("session:join", { code: code.trim() }, (ack) => {
      if (ack.ok) {
        sessionIdRef.current = ack.session.id;
        setSession(ack.session);
        setError(undefined);
      } else {
        setError(ack.error);
      }
    });
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
      <h1>Join a Session</h1>

      {!session && (
        <div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Session code"
            style={{ padding: "0.5rem", width: "100%", marginBottom: "0.5rem" }}
          />
          <button onClick={handleJoin}>Join</button>
        </div>
      )}

      {session && (
        <div>
          <p>Topic: {session.topic}</p>
          <p>State: {session.state}</p>
          <p>Viewers connected: {session.viewerCount}</p>
        </div>
      )}

      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
