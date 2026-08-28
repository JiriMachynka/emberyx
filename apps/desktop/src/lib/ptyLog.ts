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
import { createAnsiScreen, type AnsiScreen } from "@/lib/ansi";

type PtyEvent =
  | { type: "output"; data: string }
  | { type: "exit"; data: number | null };

export type PtyLogStatus = "starting" | "running" | "exited";

interface Entry {
  ptyId: number | null;
  screen: AnsiScreen;
  /** The stream as it arrived, for a view that owns a terminal grid: line
   *  buffers can't feed one, because a redraw is cursor motion, not lines. */
  raw: RawBuffer;
  decoder: TextDecoder;
  status: PtyLogStatus;
  exitCode: number | null;
  subs: Set<() => void>;
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

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const notify = (entry: Entry) => {
  for (const cb of entry.subs) cb();
};

export interface SpawnLogOptions {
  sessionId: string;
  cwd: string;
  command?: string;
  maxLines: number;
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

  const entry: Entry = {
    ptyId: null,
    screen: createAnsiScreen(opts.maxLines),
    raw: existing?.raw ?? createRawBuffer(),
    decoder: new TextDecoder(),
    status: "starting",
    exitCode: null,
    subs: existing?.subs ?? new Set(),
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
      entry.screen.push(chunk);
      pushRaw(entry.raw, chunk);
      for (const cb of entry.rawSubs) cb(chunk);
      notify(entry);
    } else {
      entry.status = "exited";
      entry.exitCode = event.data;
      notify(entry);
      entry.onExit?.(event.data);
    }
  };

  try {
    const id = await invoke<number>("pty_spawn", {
      cwd: opts.cwd,
      command: opts.command ?? null,
      cols: opts.cols ?? 160,
      rows: opts.rows ?? 40,
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
    if (entry.killWhenSpawned) {
      sessions.delete(opts.sessionId);
      void invoke("pty_kill", { id });
      return;
    }
    notify(entry);
  } catch (e) {
    entry.status = "exited";
    entry.screen.push(`${String(e)}\n`);
    notify(entry);
    entry.onExit?.(null);
  }
}

export const subscribeLog = (sessionId: string, cb: () => void): (() => void) => {
  let entry = sessions.get(sessionId);
  if (!entry) {
    // Subscribing ahead of the spawn is fine — keep the seat.
    entry = {
      ptyId: null,
      screen: createAnsiScreen(1),
      raw: createRawBuffer(),
      decoder: new TextDecoder(),
      status: "starting",
      exitCode: null,
      subs: new Set(),
      rawSubs: new Set(),
      spawned: false,
      killWhenSpawned: false,
    };
    sessions.set(sessionId, entry);
  }
  entry.subs.add(cb);
  return () => {
    sessions.get(sessionId)?.subs.delete(cb);
  };
};

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

export const logLines = (sessionId: string): readonly string[] =>
  sessions.get(sessionId)?.screen.lines() ?? [];

export const logVersion = (sessionId: string): number =>
  sessions.get(sessionId)?.screen.version() ?? 0;

export const logState = (
  sessionId: string
): { status: PtyLogStatus; exitCode: number | null } | null => {
  const entry = sessions.get(sessionId);
  return entry ? { status: entry.status, exitCode: entry.exitCode } : null;
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
  const id = sessions.get(sessionId)?.ptyId;
  if (id != null) await invoke("pty_resize", { id, cols, rows }).catch(() => {});
}

export async function writeLog(sessionId: string, data: string): Promise<void> {
  const id = sessions.get(sessionId)?.ptyId;
  if (id != null) await invoke("pty_write", { id, data });
}
