import { useEffect, useRef } from "react";
import type { FitAddon, Terminal } from "ghostty-web";
import { loadGhostty, terminalTheme } from "@/lib/ghostty";
import { rawLog, resizeLog, subscribeRaw } from "@/lib/ptyLog";
import { withGlyphFallback } from "@/lib/terminalFont";

interface LogPaneProps {
  sessionId: string;
  fontFamily: string;
  fontSize: number;
  /** Only the visible log fits itself; a hidden pane can't measure. */
  active: boolean;
}

/**
 * Read-only view over a ptyLog session, rendered by the same Ghostty VT the
 * terminal uses. It replaced an ANSI-to-HTML pass that re-highlighted the
 * whole buffer on every settle — and that pass was the last thing in the app
 * pulling in a second copy of Shiki.
 *
 * The PTY belongs to lib/ptyLog, so this mounts and unmounts freely; closing
 * the panel never touches the dev server. Nothing is wired to `onData`: a dev
 * server's output is something you read, not a shell you type into.
 */
export function LogPane({ sessionId, fontFamily, fontSize, active }: LogPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    void loadGhostty().then(({ Terminal, FitAddon }) => {
      if (disposed || !rootRef.current) return;
      const term = new Terminal({
        fontFamily: withGlyphFallback(fontFamily),
        fontSize,
        theme: terminalTheme(),
        cursorBlink: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(rootRef.current);
      fit.fit();
      fit.observeResize();

      // The child still deserves a sane COLUMNS, so the grid's own geometry
      // drives the resize rather than a character-width guess.
      term.onResize(({ cols, rows }) => void resizeLog(sessionId, cols, rows));

      // Replay first, then live: subscribing before the replay would interleave
      // a chunk into the middle of the history it already contains.
      const backlog = rawLog(sessionId);
      if (backlog.length > 0) term.write(backlog);
      unsubscribe = subscribeRaw(sessionId, (chunk) => term.write(chunk));

      termRef.current = term;
      fitRef.current = fit;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      fitRef.current?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Appearance changes in place: a rebuilt grid would lose the screen.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = withGlyphFallback(fontFamily);
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontFamily, fontSize]);

  useEffect(() => {
    if (active) fitRef.current?.fit();
  }, [active]);

  return (
    <div ref={rootRef} className="h-full w-full overflow-hidden rounded-md bg-background p-1" />
  );
}
