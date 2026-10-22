import { useEffect, useId, useRef, useState } from "react";

export interface ShareLinkProps {
  /** The session's short join code. */
  readonly code: string;
  /** Viewers currently connected. */
  readonly viewerCount: number;
  /** Origin the viewer page is served from. Defaults to the current page's origin. */
  readonly baseUrl?: string | undefined;
  /** Shown in the native share sheet's title. */
  readonly topic?: string | undefined;
}

type CopyStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "copied"; readonly what: "link" | "code" }
  | { readonly kind: "failed" };

const STATUS_RESET_MS = 2500;

/** Builds the URL a viewer opens to join: `<origin>/viewer?code=<CODE>`. */
export function buildViewerUrl(code: string, baseUrl?: string): string {
  const origin = (baseUrl ?? window.location.origin).replace(/\/+$/, "");
  return `${origin}/viewer?code=${encodeURIComponent(code)}`;
}

/**
 * Copies text with the async Clipboard API, falling back to selecting the
 * given input and the legacy copy command. The Clipboard API is unavailable
 * on non-secure origins and can be refused by the browser; the fallback keeps
 * the button working in both cases.
 */
async function copyText(text: string, fallbackInput: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy path.
  }
  if (!fallbackInput) {
    return false;
  }
  fallbackInput.focus();
  fallbackInput.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/**
 * Host-side panel for inviting viewers: shows the join code and a ready-made
 * viewer link, each with a copy button, a native share button where the
 * browser supports one (mostly phones), and the live viewer count.
 *
 * The link carries the code in the query string, so a viewer who refreshes
 * the page lands on the same URL and can rejoin without retyping anything.
 */
export function ShareLink({ code, viewerCount, baseUrl, topic }: ShareLinkProps): JSX.Element {
  const [status, setStatus] = useState<CopyStatus>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const linkInputId = useId();

  const url = buildViewerUrl(code, baseUrl);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  function showStatus(next: CopyStatus): void {
    setStatus(next);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setStatus({ kind: "idle" }), STATUS_RESET_MS);
  }

  async function handleCopy(what: "link" | "code"): Promise<void> {
    const ok = await copyText(what === "link" ? url : code, what === "link" ? inputRef.current : null);
    showStatus(ok ? { kind: "copied", what } : { kind: "failed" });
  }

  async function handleShare(): Promise<void> {
    try {
      await navigator.share({
        title: topic ?? "Live coding session",
        text: `Join my live session with code ${code}`,
        url,
      });
    } catch {
      // The person dismissed the share sheet; nothing to report.
    }
  }

  let statusText = "";
  if (status.kind === "copied") {
    statusText = status.what === "link" ? "Link copied." : "Code copied.";
  } else if (status.kind === "failed") {
    statusText = "Could not copy automatically. Select the link and press Ctrl+C (Cmd+C on Mac).";
  }

  return (
    <section
      aria-label="Share this session"
      style={{
        fontFamily: "sans-serif",
        border: "1px solid #d0d4da",
        borderRadius: 8,
        padding: "1rem",
        maxWidth: 480,
      }}
    >
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>Invite viewers</h2>

      <p style={{ margin: "0 0 0.75rem" }}>
        Join code:{" "}
        <strong style={{ fontSize: "1.5rem", letterSpacing: "0.1em" }}>{code}</strong>{" "}
        <button type="button" onClick={() => void handleCopy("code")}>
          Copy code
        </button>
      </p>

      <label htmlFor={linkInputId} style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
        Viewer link
      </label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          id={linkInputId}
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          style={{ flex: 1, padding: "0.4rem", fontFamily: "monospace", fontSize: 12 }}
        />
        <button type="button" onClick={() => void handleCopy("link")}>
          Copy link
        </button>
        {canShare && (
          <button type="button" onClick={() => void handleShare()}>
            Share…
          </button>
        )}
      </div>

      <p role="status" aria-live="polite" style={{ minHeight: "1.25rem", margin: "0.5rem 0 0", fontSize: 13 }}>
        {statusText}
      </p>

      <p style={{ margin: "0.25rem 0 0", fontSize: 13, color: "#555" }}>
        {viewerCount === 1 ? "1 viewer connected" : `${viewerCount} viewers connected`}
      </p>
    </section>
  );
}