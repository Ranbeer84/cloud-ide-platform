import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorCursorState } from "@live/shared-types";

export interface OverlayDisposable {
  dispose(): void;
}

/**
 * The few editor capabilities the overlay needs. Monaco's standalone editor
 * (the `editor` argument of @monaco-editor/react's `onMount`) satisfies this
 * structurally, so it can be passed straight in; keeping the overlay on this
 * small interface means it never imports Monaco itself.
 */
export interface OverlayEditorHandle {
  /** Pixel position of a text position relative to the editor's top-left, or null if it is scrolled out of view. */
  getScrolledVisiblePosition(position: {
    lineNumber: number;
    column: number;
  }): { top: number; left: number; height: number } | null;
  onDidScrollChange(listener: () => void): OverlayDisposable;
  onDidLayoutChange(listener: () => void): OverlayDisposable;
  onDidChangeModelContent(listener: () => void): OverlayDisposable;
}

export interface CursorOverlayProps {
  /** The viewer's read-only editor. While undefined, nothing is drawn. */
  readonly editor: OverlayEditorHandle | undefined;
  /** Latest host caret, from `sync:snapshot` or `editor:cursor`. */
  readonly cursor: EditorCursorState | undefined;
  /** File the viewer is showing. The caret is only drawn when it belongs to this file. */
  readonly activePath: string | undefined;
  /** Text on the caret's flag. */
  readonly label?: string | undefined;
  /** Caret and flag colour. Keep it light enough for dark flag text. */
  readonly color?: string | undefined;
  /** The caret dims after this long without an update. */
  readonly idleAfterMs?: number | undefined;
}

interface Coords {
  readonly top: number;
  readonly left: number;
  readonly height: number;
}

function sameCoords(a: Coords | undefined, b: Coords | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.top === b.top && a.left === b.left && a.height === b.height;
}

/** Room above the caret needed to draw its flag without being clipped. */
const FLAG_CLEARANCE_PX = 20;

/**
 * Draws the host's caret on top of the viewer's read-only editor.
 *
 * Place it inside the same `position: relative` element that wraps the
 * editor; it fills that element and ignores pointer events, so it never
 * interferes with selecting or scrolling the viewer's text.
 *
 * Cursor updates arrive at most ~10 times per second (the server enforces
 * that), so the caret glides between positions with a short CSS transition
 * instead of jumping. Scrolling, resizing and content changes re-measure the
 * caret, coalesced to one measurement per animation frame.
 */
export function CursorOverlay({
  editor,
  cursor,
  activePath,
  label = "Host",
  color = "#f5a623",
  idleAfterMs = 4000,
}: CursorOverlayProps): JSX.Element | null {
  const [coords, setCoords] = useState<Coords | undefined>(undefined);
  const [idle, setIdle] = useState(false);
  const frameRef = useRef<number | undefined>(undefined);

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const measure = useCallback((): void => {
    if (!editor || !cursor || activePath === undefined || cursor.path !== activePath) {
      setCoords(undefined);
      return;
    }
    const position = editor.getScrolledVisiblePosition({
      lineNumber: cursor.position.line,
      column: cursor.position.column,
    });
    const next: Coords | undefined = position
      ? { top: position.top, left: position.left, height: position.height }
      : undefined;
    setCoords((previous) => (sameCoords(previous, next) ? previous : next));
  }, [editor, cursor, activePath]);

  // The scheduled frame always runs the newest `measure`, never a stale one.
  const measureRef = useRef(measure);
  useEffect(() => {
    measureRef.current = measure;
  }, [measure]);

  // Stable identity, so the editor subscriptions below are not torn down on every cursor update.
  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== undefined) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = undefined;
      measureRef.current();
    });
  }, []);

  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const subscriptions = [
      editor.onDidScrollChange(scheduleMeasure),
      editor.onDidLayoutChange(scheduleMeasure),
      editor.onDidChangeModelContent(scheduleMeasure),
    ];
    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      if (frameRef.current !== undefined) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
  }, [editor, scheduleMeasure]);

  useEffect(() => {
    setIdle(false);
    if (!cursor) {
      return;
    }
    const timer = window.setTimeout(() => setIdle(true), idleAfterMs);
    return () => window.clearTimeout(timer);
  }, [cursor, idleAfterMs]);

  if (!coords) {
    return null;
  }

  const flagBelow = coords.top < FLAG_CLEARANCE_PX;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 10,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `translate(${coords.left}px, ${coords.top}px)`,
          transition: reducedMotion ? "none" : "transform 90ms linear, opacity 300ms ease",
          opacity: idle ? 0.35 : 1,
          willChange: "transform",
        }}
      >
        <div style={{ width: 2, height: coords.height, background: color }} />
        <div
          style={{
            position: "absolute",
            left: 0,
            ...(flagBelow ? { top: coords.height } : { bottom: coords.height }),
            padding: "1px 6px",
            borderRadius: 3,
            background: color,
            color: "#111318",
            font: "600 11px/16px sans-serif",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}