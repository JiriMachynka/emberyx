/**
 * Module-level owner of log-style PTY sessions (dev servers).
 *
 * The PTY's lifetime belongs here, not to a React component: a view
 * subscribes to a session's buffer and can unmount freely without killing
 * the process — the old TerminalPane killed its PTY on unmount, which forced
 * every consumer to stay mounted forever behind `hidden`. Killing is an
 * explicit act (stop button, project teardown) or the child exiting.
 */
import { Channel, invoke } from "@tauri-apps/api/core";

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; data: number | null };

type PtyLogStatus = "starting" | "running" | "exited";

interface Entry {
  ptyId: number | null;
  /** Last size a view asked for, applied when the spawn lands. Without it a
   *  fit that resolves before the PTY does leaves the child at the default
   *  width, and a shell redraws its prompt against a screen of another size. */
  size: { cols: number; rows: number } | null;
  /** The stream as it arrived. Every consumer owns a terminal grid, and a
   *  redraw is cursor motion — the bytes have to survive verbatim. */
  raw: RawBuffer;
  decoder: TextDecoder;
  /** Read by spawn (is one already live?) and kill (did it resolve yet?). */
  status: PtyLogStatus;
  rawSubs: Set<(chunk: string) => void>;
  onExit?: (code: number | null) => void;
  /** False on the placeholder a subscriber creates ahead of the spawn. */
  spawned: boolean;
  /** Kill requested before the spawn resolved — honored as soon as it does. */
  killWhenSpawned: boolean;
}

/** Replay budget for a reopened view. The terminal keeps its own scrollback
 *  once attached, so this only has to cover what it missed while unmounted. */
const RAW_MAX_CHARS = 256 * 1024;

interface RawBuffer {
  chunks: string[];
  chars: number;
}

const createRawBuffer = (): RawBuffer => ({ chunks: [], chars: 0 });

const pushRaw = (buf: RawBuffer, chunk: string): void => {
  buf.chunks.push(chunk);
  buf.chars += chunk.length;
  // Dropping from the front loses the oldest escape sequences, so a replay can
  // start mid-state. The emulator recovers on the next full redraw, which is
  // the honest trade for a bounded buffer.
  while (buf.chars > RAW_MAX_CHARS && buf.chunks.length > 1) {
    buf.chars -= buf.chunks.shift()!.length;
  }
};

const sessions = new Map<string, Entry>();

/** The project's interactive shell — one per project path, shared by every
 *  terminal view of it. */
export const shellSessionId = (cwd: string) => `shell:${cwd}`;

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

export interface SpawnLogOptions {
  sessionId: string;
  cwd: string;
  command?: string;
  cols?: number;
  rows?: number;
  onExit?: (code: number | null) => void;
}

/** Spawn a PTY for the session unless one is already live. */
export async function spawnLog(opts: SpawnLogOptions): Promise<void> {
  const existing = sessions.get(opts.sessionId);
  if (existing?.spawned && existing.status !== "exited" && !existing.killWhenSpawned) {
    return;
  }

  const size = existing?.size ?? null;
  const cols = opts.cols ?? size?.cols ?? 160;
  const rows = opts.rows ?? size?.rows ?? 40;

  const entry: Entry = {
    ptyId: null,
    size,
    raw: existing?.raw ?? createRawBuffer(),
    decoder: new TextDecoder(),
    status: "starting",
    rawSubs: existing?.rawSubs ?? new Set(),
    onExit: opts.onExit,
    spawned: true,
    killWhenSpawned: false,
  };
  sessions.set(opts.sessionId, entry);

  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    if (sessions.get(opts.sessionId) !== entry) return;
    if (event.type === "output") {
      const chunk = entry.decoder.decode(base64ToBytes(event.data), { stream: true });
      pushRaw(entry.raw, chunk);
      for (const cb of entry.rawSubs) cb(chunk);
    } else {
      entry.status = "exited";
      entry.onExit?.(event.data);
    }
  };

  try {
    const id = await invoke<number>("pty_spawn", {
      cwd: opts.cwd,
      command: opts.command ?? null,
      cols,
      rows,
      onEvent: channel,
    });
    if (sessions.get(opts.sessionId) !== entry) {
      // Strict Mode can unmount and remount a pane while spawn is still in
      // flight. The stale PTY must not survive after its entry is replaced.
      void invoke("pty_kill", { id });
      return;
    }
    entry.ptyId = id;
    if (entry.status === "starting") entry.status = "running";
    // A view that measured itself while the spawn was in flight recorded its
    // size and found no ptyId to send it to.
    if (entry.size && (entry.size.cols !== cols || entry.size.rows !== rows)) {
      void invoke("pty_resize", {
        id,
        cols: entry.size.cols,
        rows: entry.size.rows,
      }).catch(() => {});
    }
    if (entry.killWhenSpawned) {
      sessions.delete(opts.sessionId);
      void invoke("pty_kill", { id });
      return;
    }
  } catch {
    entry.status = "exited";
    entry.onExit?.(null);
  }
}

/** Everything the session has emitted that is still buffered, for a view
 *  attaching after the fact. */
export const rawLog = (sessionId: string): string =>
  sessions.get(sessionId)?.raw.chunks.join("") ?? "";

/** Stream new output to a terminal grid. Returns an unsubscribe. */
export const subscribeRaw = (
  sessionId: string,
  cb: (chunk: string) => void
): (() => void) => {
  const entry = sessions.get(sessionId);
  if (!entry) return () => {};
  entry.rawSubs.add(cb);
  return () => {
    sessions.get(sessionId)?.rawSubs.delete(cb);
  };
};

/** Kill the child (SIGTERM, then SIGKILL) and forget the buffer. */
export async function killLog(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  if (entry.ptyId != null) {
    await invoke("pty_kill", { id: entry.ptyId }).catch(() => {});
  } else if (entry.status === "starting") {
    entry.killWhenSpawned = true;
    sessions.set(sessionId, entry);
  }
}

/** Drop a finished session's buffer without touching any process. */
export const disposeLog = (sessionId: string): void => {
  sessions.delete(sessionId);
};

export async function resizeLog(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  entry.size = { cols, rows };
  if (entry.ptyId != null) {
    await invoke("pty_resize", { id: entry.ptyId, cols, rows }).catch(() => {});
  }
}

export async function writeLog(sessionId: string, data: string): Promise<void> {
  const id = sessions.get(sessionId)?.ptyId;
  if (id != null) await invoke("pty_write", { id, data });
}
