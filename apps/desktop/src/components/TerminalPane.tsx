import { memo, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { classify, stripAnsi } from "@/lib/accountState";
import type { AgentBackend } from "@/lib/agentBackend";
import { useAgentStore } from "@/lib/agentStore";
import "@xterm/xterm/css/xterm.css";

/** How much stripped output to keep for matching. A limit message spans a few
 *  lines at most, but PTY chunks are coalesced arbitrarily, so a message can
 *  straddle several — the tail is what lets a split message still match. */
const TAIL_LIMIT = 4096;

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; data: number | null };

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface TerminalPaneProps {
  /** Emberyx session id — reported by hooks so the UI can correlate events. */
  sessionId: string;
  /** Absolute path the shell starts in. */
  cwd: string;
  /** Command auto-run on open (e.g. "claude"). */
  command?: string;
  /** Stable key for scrollback persistence; when set, this pane's output is
   *  saved and replayed on restart. Omitted for secondary/dev panes. */
  persistKey?: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  /** Agent CLI running in this pane; decides how its output is classified. */
  backend?: AgentBackend;
  /** Whether this pane is the visible/active tab (drives keyboard focus). */
  active: boolean;
  /** Called with this pane's sessionId when the PTY exits on its own, so the
   *  owner can drop a session that is no longer running. */
  onExit?: (sessionId: string) => void;
}

/** Append the bundled icons-only Nerd Font so powerline/Starship prompts show
 *  their glyphs regardless of the user's chosen base font. */
const withNerd = (family: string) => `${family}, "Symbols Nerd Font"`;

function TerminalPaneImpl({
  sessionId,
  cwd,
  command,
  persistKey,
  fontFamily,
  fontSize,
  scrollback,
  backend = "claude",
  active,
  onExit,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Font/scrollback config captured once; live updates handled by a second
  // effect so changing them never restarts the shell.
  const initialConfig = useRef({ fontFamily, fontSize, scrollback });

  // Held in a ref so a caller's changing callback identity never lands in the
  // shell effect's deps — that would respawn the PTY.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: withNerd(initialConfig.current.fontFamily),
      fontSize: initialConfig.current.fontSize,
      scrollback: initialConfig.current.scrollback,
      cursorBlink: true,
      theme: {
        background: "#1a1a1e",
        foreground: "#e4e4e7",
        cursor: "#f59e0b",
      },
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    // GPU-accelerated renderer for high-throughput output; falls back to the
    // DOM renderer automatically if WebGL is unavailable or the context is lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable — DOM renderer remains */
    }
    try {
      fit.fit();
    } catch {
      /* container not sized yet */
    }

    // The bundled Nerd Font loads lazily; once it's ready, rebuild the glyph
    // atlas so powerline/Starship icons aren't tofu on first paint.
    void document.fonts
      .load(`${initialConfig.current.fontSize}px "Symbols Nerd Font"`)
      .then(() => {
        try {
          term.clearTextureAtlas();
        } catch {
          /* renderer without a texture atlas */
        }
      });

    let ptyId: number | null = null;
    let disposed = false;

    // Account-failure detection runs beside the write, never in front of it —
    // these locals live for one shell, so a restart starts from an empty tail.
    const decoder = new TextDecoder();
    let tail = "";
    let lastTail = "";

    const detect = (bytes: Uint8Array) => {
      // Streaming decode: a multi-byte char can be split across PTY chunks.
      const chunk = stripAnsi(decoder.decode(bytes, { stream: true }));
      // The TUI repaints on every keystroke and spinner frame; most chunks are
      // pure cursor movement, so skip them before touching the patterns.
      if (!chunk.trim()) return;
      tail = (tail + chunk).slice(-TAIL_LIMIT);
      if (tail === lastTail) return;
      lastTail = tail;
      const issue = classify(tail, backend);
      if (!issue) return;
      useAgentStore.getState().reportAccountIssue(sessionId, issue);
      // Drop the matched window so the same message can't keep re-firing as it
      // scrolls; a genuinely new failure refills the tail.
      tail = "";
    };

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (msg) => {
      if (msg.type === "output") {
        const bytes = base64ToBytes(msg.data);
        term.write(bytes);
        detect(bytes);
      } else {
        term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
        // Only a self-terminating process reports upward; an exit caused by our
        // own unmount kill would drop a session the owner is already removing.
        if (!disposed) onExitRef.current?.(sessionId);
      }
    };

    // Replay any persisted scrollback first, then start the live session so
    // restored output always precedes new output.
    void (async () => {
      if (persistKey) {
        try {
          const b64 = await invoke<string>("read_scrollback", { persistKey });
          if (disposed) return;
          if (b64) {
            term.write(base64ToBytes(b64));
            term.write("\r\n\x1b[90m[previous session restored]\x1b[0m\r\n");
          }
        } catch {
          /* no prior scrollback */
        }
      }
      if (disposed) return;
      try {
        const id = await invoke<number>("pty_spawn", {
          cwd,
          command,
          sessionId,
          persistKey: persistKey ?? null,
          cols: term.cols,
          rows: term.rows,
          onEvent: channel,
        });
        if (disposed) {
          void invoke("pty_kill", { id });
          return;
        }
        ptyId = id;
      } catch (e) {
        term.write(`\r\n\x1b[31mspawn failed: ${e}\x1b[0m\r\n`);
      }
    })();

    // Shift+Enter should insert a newline in the agent prompt, not submit it.
    // xterm sends a bare CR for both Enter and Shift+Enter, so intercept the
    // latter and emit LF, which Claude Code's prompt inserts as a newline (CR
    // submits, LF does not — verified against the CC TUI).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        // preventDefault stops the follow-up keypress event, which xterm would
        // otherwise turn into a CR — that CR reaches CC alongside our LF and
        // submits the prompt, cancelling the newline.
        e.preventDefault();
        if (ptyId !== null) void invoke("pty_write", { id: ptyId, data: "\n" });
        return false;
      }
      return true;
    });

    const dataSub = term.onData((data) => {
      if (ptyId !== null) void invoke("pty_write", { id: ptyId, data });
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ptyId !== null) void invoke("pty_resize", { id: ptyId, cols, rows });
    });

    // Coalesce refits: toggling the sidebar animates the layout width for
    // ~200ms, firing the observer every frame. Refitting mid-animation resizes
    // the WebGL canvas repeatedly, which reads as a blink — so wait for the
    // layout to settle and refit once.
    let fitTimer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          /* container detached */
        }
      }, 60);
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      dataSub.dispose();
      resizeSub.dispose();
      if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, cwd, command, persistKey]);

  // Focus the terminal when this tab becomes active so keystrokes (incl. CC's
  // arrow-key resume picker) go to it, not the UI that opened it. Deferred a
  // frame so it wins over Radix restoring focus to a just-closed menu trigger.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // Apply font / scrollback changes live to the running terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = withNerd(fontFamily);
    term.options.fontSize = fontSize;
    term.options.scrollback = scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* container not sized */
    }
  }, [fontFamily, fontSize, scrollback]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}

// All props are primitives (ids, paths, font settings, active flag), so the
// default shallow compare skips re-renders on unrelated App state ticks
// (agent status / file-edit / usage events) across every mounted session.
export const TerminalPane = memo(TerminalPaneImpl);
