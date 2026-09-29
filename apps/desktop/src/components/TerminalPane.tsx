import { useEffect, useRef } from "react";
import type { FitAddon, Terminal } from "ghostty-web";
import { loadGhostty, terminalTheme } from "@/lib/ghostty";
import {
  isExited,
  rawLog,
  resizeLog,
  shellSessionId,
  spawnLog,
  subscribeExit,
  subscribeRaw,
  writeLog,
} from "@/lib/ptyLog";
import { createTerminalFeed } from "@/lib/terminalFeed";
import { withGlyphFallback } from "@/lib/terminalFont";

interface TerminalPaneProps {
  cwd: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  active: boolean;
}

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
  const sessionId = shellSessionId(cwd);
  // Read at mount only: scrollback is a live setting, and a shell must not be
  // restarted because a number in Settings changed.
  const scrollbackRef = useRef(scrollback);
  // Keystrokes of a dead shell must not land anywhere — until Enter restarts,
  // every key but \r is dropped.
  const exitedRef = useRef(false);

  // Spawn only — never kill. The dock unmounts this pane when its tab closes
  // and the path changes whenever a thread in another project is opened; both
  // used to kill the shell. Project teardown stops it (useWorkspace).
  useEffect(() => {
    void spawnLog({ sessionId, cwd });
  }, [cwd, sessionId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let unsubscribeRaw: (() => void) | null = null;
    let unsubscribeExit: (() => void) | null = null;
    let feed: ReturnType<typeof createTerminalFeed> | null = null;

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
      // grid never draws a keystroke it hasn't been told to. While the shell
      // is dead, Enter is the restart action and nothing else passes through.
      term.onData((data) => {
        if (exitedRef.current) {
          if (data === "\r") {
            exitedRef.current = false;
            void spawnLog({ sessionId, cwd });
          }
          return;
        }
        void writeLog(sessionId, data);
      });
      // Registered before the first fit: the fit that lands on open is the one
      // that matters, and a resize the child never hears leaves it writing for
      // a screen of a different width — which is how a prompt draws twice.
      term.onResize(({ cols, rows }) => void resizeLog(sessionId, cols, rows));
      fit.fit();
      // fit() is a no-op when the size is already right, so it can also emit
      // nothing at all. The child still has to be told what it is attached to.
      const cols = term.cols;
      const rows = term.rows;
      void resizeLog(sessionId, cols, rows);
      fit.observeResize();

      // One queue, one path into the terminal: backlog and live output share
      // the same pending string emptied by one frame loop, so ordering is
      // correct by construction — and a big backlog still never freezes a
      // frame, because backlog and live share the per-frame budget.
      feed = createTerminalFeed(
        (data) => term.write(data),
        (cb) => requestAnimationFrame(cb),
        (id) => cancelAnimationFrame(id)
      );

      // Backlog and subscription must land in the same tick: a chunk that
      // arrives between rawLog and subscribeRaw would never be replayed and
      // never streamed — the gap is a lost line.
      feed.push(rawLog(sessionId));
      unsubscribeRaw = subscribeRaw(sessionId, (chunk) => feed!.push(chunk));

      unsubscribeExit = subscribeExit(sessionId, (code) => {
        exitedRef.current = true;
        const what =
          code === null ? "exited" : `exited with code ${code}`;
        void resizeLog(sessionId, term.cols, term.rows);
        feed!.push(`\r\n\x1b[2m[Process ${what} — press Enter to restart]\x1b[0m\r\n`);
      });
      // A view that mounts after the exit never gets an event — say it now.
      if (isExited(sessionId)) {
        exitedRef.current = true;
        feed.push("\r\n\x1b[2m[Process exited — press Enter to restart]\x1b[0m\r\n");
      }

      termRef.current = term;
      fitRef.current = fit;
    });

    return () => {
      disposed = true;
      unsubscribeRaw?.();
      unsubscribeExit?.();
      feed?.dispose();
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
