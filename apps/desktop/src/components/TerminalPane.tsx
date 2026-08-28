import { useEffect, useRef } from "react";
import type { FitAddon, Terminal } from "ghostty-web";
import { loadGhostty, terminalTheme } from "@/lib/ghostty";
import {
  killLog,
  rawLog,
  resizeLog,
  spawnLog,
  subscribeRaw,
  writeLog,
} from "@/lib/ptyLog";
import { withGlyphFallback } from "@/lib/terminalFont";

interface TerminalPaneProps {
  cwd: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  active: boolean;
}

const terminalSessionId = (cwd: string) => `shell:${cwd}`;

/**
 * An interactive shell, rendered by Ghostty's VT.
 *
 * The PTY belongs to lib/ptyLog, so this can unmount without killing the shell;
 * on the way back it replays the buffered stream into a fresh grid. What it
 * cannot do is share ptyLog's *line* buffer — a terminal is a screen, and the
 * sequences that move a cursor around it are exactly what a line buffer drops.
 */
export function TerminalPane({
  cwd,
  fontFamily,
  fontSize,
  scrollback,
  active,
}: TerminalPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = terminalSessionId(cwd);

  useEffect(() => {
    void spawnLog({ sessionId, cwd, maxLines: scrollback });
    // The dock keeps this pane mounted after its tab closes precisely so the
    // shell survives; unmounting means the project is going away.
    return () => {
      void killLog(sessionId);
    };
  }, [cwd, scrollback, sessionId]);

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
        scrollback,
        theme: terminalTheme(),
        cursorBlink: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(rootRef.current);
      fit.fit();
      fit.observeResize();

      // Keys go to the child, and the child's echo comes back as output — the
      // grid never draws a keystroke it hasn't been told to.
      term.onData((data) => void writeLog(sessionId, data));
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
  }, [sessionId, scrollback]);

  // Appearance changes in place: a rebuilt terminal would lose the screen.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = withGlyphFallback(fontFamily);
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontFamily, fontSize]);

  useEffect(() => {
    if (!active) return;
    // A hidden tab can't measure itself, so the fit it missed happens here.
    fitRef.current?.fit();
    termRef.current?.focus();
  }, [active]);

  return (
    <div
      ref={rootRef}
      onClick={() => termRef.current?.focus()}
      className="h-full w-full overflow-hidden rounded-md bg-canvas p-2"
    />
  );
}
