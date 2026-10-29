import { useId, useState, type FormEvent, type ReactNode } from "react";
import { LoginError, useAuth } from "./AuthContext";

export interface LoginProps {
  /** Called after a successful sign-in. */
  readonly onSignedIn?: (() => void) | undefined;
}

/**
 * Username and password form. It talks to the orchestrator through
 * AuthContext and shows the server's failure reasons without ever echoing the
 * password. On success the AuthProvider flips to "signedIn", so a parent using
 * <RequireAuth> swaps this form out on its own.
 */
export function Login({ onSignedIn }: LoginProps): JSX.Element {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await login(username.trim(), password);
      setPassword("");
      onSignedIn?.();
    } catch (caught) {
      // Never keep a rejected password in the form.
      setPassword("");
      setError(caught instanceof LoginError ? caught.message : "Sign-in failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !submitting && username.trim().length > 0 && password.length > 0;

  return (
    <main style={{ fontFamily: "sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", padding: "1rem" }}>
      <form
        onSubmit={(event) => void handleSubmit(event)}
        aria-describedby={error ? errorId : undefined}
        style={{ width: "100%", maxWidth: 360, display: "grid", gap: "0.75rem" }}
      >
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Sign in</h1>

        <label htmlFor={usernameId} style={{ display: "grid", gap: 4, fontSize: 14 }}>
          Username
          <input
            id={usernameId}
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={submitting}
            style={{ padding: "0.5rem", fontSize: 16 }}
          />
        </label>

        <label htmlFor={passwordId} style={{ display: "grid", gap: 4, fontSize: 14 }}>
          Password
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
            style={{ padding: "0.5rem", fontSize: 16 }}
          />
        </label>

        {error !== undefined && (
          <p id={errorId} role="alert" style={{ margin: 0, color: "#b00020", fontSize: 14 }}>
            {error}
          </p>
        )}

        <button type="submit" disabled={!canSubmit} style={{ padding: "0.6rem", fontSize: 16 }}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

/**
 * Renders `children` for a signed-in person, the sign-in form for a signed-out
 * one, and a placeholder while the stored session is being checked.
 */
export function RequireAuth({ children }: { readonly children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <main style={{ fontFamily: "sans-serif", display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <p role="status">Checking your session…</p>
      </main>
    );
  }
  if (status === "signedOut") {
    return <Login />;
  }
  return <>{children}</>;
}