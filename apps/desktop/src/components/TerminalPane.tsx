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
  // Read at mount only: scrollback is a live setting, and a shell must not be
  // restarted because a number in Settings changed.
  const scrollbackRef = useRef(scrollback);

  useEffect(() => {
    void spawnLog({ sessionId, cwd });
    // The dock keeps this pane mounted after its tab closes precisely so the
    // shell survives; unmounting means the project is going away.
    return () => {
      void killLog(sessionId);
    };
  }, [cwd, sessionId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    let frame: number | null = null;
    let pending = "";

    void loadGhostty().then(({ Terminal, FitAddon }) => {
      if (disposed || !rootRef.current) return;
      const term = new Terminal({
        fontFamily: withGlyphFallback(fontFamily),
        fontSize,
        scrollback: scrollbackRef.current,
        theme: terminalTheme(),
        cursorBlink: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(rootRef.current);

      // Keys go to the child, and the child's echo comes back as output — the
      // grid never draws a keystroke it hasn't been told to.
      term.onData((data) => void writeLog(sessionId, data));
      // Registered before the first fit: the fit that lands on open is the one
      // that matters, and a resize the child never hears leaves it writing for
      // a screen of a different width — which is how a prompt draws twice.
      term.onResize(({ cols, rows }) => void resizeLog(sessionId, cols, rows));
      fit.fit();
      // fit() is a no-op when the size is already right, so it can also emit
      // nothing at all. The child still has to be told what it is attached to.
      void resizeLog(sessionId, term.cols, term.rows);
      fit.observeResize();

      // Replay first, then live: subscribing before the replay would interleave
      // a chunk into the middle of the history it already contains.
      const backlog = rawLog(sessionId);
      if (backlog.length > 0) term.write(backlog);
      // One write per frame, not per chunk: a build's output arrives as
      // hundreds of small chunks and each write is a wasm call plus a repaint.
      unsubscribe = subscribeRaw(sessionId, (chunk) => {
        pending += chunk;
        frame ??= requestAnimationFrame(() => {
          frame = null;
          const data = pending;
          pending = "";
          if (data.length > 0) term.write(data);
        });
      });

      termRef.current = term;
      fitRef.current = fit;
    });

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      unsubscribe?.();
      fitRef.current?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Appearance changes in place: a rebuilt terminal would lose the screen.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = withGlyphFallback(fontFamily);
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontFamily, fontSize]);

  useEffect(() => {
    scrollbackRef.current = scrollback;
    const term = termRef.current;
    if (term) term.options.scrollback = scrollback;
  }, [scrollback]);

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
