import { beforeEach, describe, expect, it, vi } from "vitest";

// Outer-fn closure rather than `vi.hoisted`: Bun's runner has no `vi.hoisted`,
// and this suite has to pass under both (see CLAUDE.md → Tests).
const state = ((): {
  calls: [string, Record<string, unknown>][];
  channels: { onmessage: ((event: unknown) => void) | null }[];
  nextPtyId: number;
  /** Swapped by a test that needs a spawn it can resolve by hand. `vi.mocked`
   *  and `mockImplementation` are Vitest-only, and this suite runs under Bun
   *  too — a mutable hook keeps the seam in plain code. */
  spawn: (() => Promise<number>) | null;
} => ({ calls: [], channels: [], nextPtyId: 1, spawn: null }))();
const { calls, channels } = state;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
    constructor() {
      state.channels.push(this);
    }
  },
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    state.calls.push([cmd, args ?? {}]);
    if (cmd === "pty_spawn") {
      return state.spawn ? state.spawn() : Promise.resolve(state.nextPtyId++);
    }
    return Promise.resolve(null);
  }),
}));

import {
  disposeLog,
  killLog,
  logLines,
  logState,
  rawLog,
  spawnLog,
  subscribeLog,
  subscribeRaw,
} from "@/lib/ptyLog";

const b64 = (s: string) => btoa(s);

beforeEach(() => {
  calls.length = 0;
  channels.length = 0;
  state.nextPtyId = 1;
  state.spawn = null;
});

describe("ptyLog", () => {
  it("spawns, buffers output, and notifies subscribers", async () => {
    let pings = 0;
    subscribeLog("dev-1", () => pings++);
    await spawnLog({ sessionId: "dev-1", cwd: "/p", command: "bun dev", maxLines: 100 });

    expect(calls.map(([c]) => c)).toContain("pty_spawn");
    channels[0].onmessage?.({ type: "output", data: b64("ready on :3000\n") });

    expect(logLines("dev-1")).toEqual(["ready on :3000", ""]);
    expect(pings).toBeGreaterThan(0);
    expect(logState("dev-1")?.status).toBe("running");
    disposeLog("dev-1");
  });

  it("does not spawn a second PTY for a live session", async () => {
    await spawnLog({ sessionId: "dev-2", cwd: "/p", maxLines: 100 });
    await spawnLog({ sessionId: "dev-2", cwd: "/p", maxLines: 100 });
    expect(calls.filter(([c]) => c === "pty_spawn")).toHaveLength(1);
    disposeLog("dev-2");
  });

  it("reports exit and fires the onExit callback", async () => {
    const exits: (number | null)[] = [];
    await spawnLog({
      sessionId: "dev-3",
      cwd: "/p",
      maxLines: 100,
      onExit: (code) => exits.push(code),
    });
    channels[0].onmessage?.({ type: "exit", data: 1 });

    expect(logState("dev-3")).toEqual({ status: "exited", exitCode: 1 });
    expect(exits).toEqual([1]);
    disposeLog("dev-3");
  });

  it("kill sends pty_kill and forgets the buffer", async () => {
    await spawnLog({ sessionId: "dev-4", cwd: "/p", maxLines: 100 });
    await killLog("dev-4");

    expect(calls.some(([c, a]) => c === "pty_kill" && a.id === 1)).toBe(true);
    expect(logState("dev-4")).toBeNull();
    expect(logLines("dev-4")).toEqual([]);
  });

  it("assembles output split across events", async () => {
    await spawnLog({ sessionId: "dev-5", cwd: "/p", maxLines: 100 });
    channels[0].onmessage?.({ type: "output", data: b64("a\x1b[3") });
    channels[0].onmessage?.({ type: "output", data: b64("1mred\x1b[0m\n") });
    expect(logLines("dev-5")).toEqual(["a\x1b[31mred\x1b[0m", ""]);
    disposeLog("dev-5");
  });

  it("keeps the raw stream for a terminal grid, escape sequences intact", async () => {
    // The line buffer normalises; a VT needs exactly what the child wrote —
    // this is a cursor-up redraw, the shape that made p10k draw twice.
    await spawnLog({ sessionId: "sh-1", cwd: "/p", maxLines: 100 });
    channels[0].onmessage?.({ type: "output", data: b64("first\r\n") });
    channels[0].onmessage?.({ type: "output", data: b64("\x1b[1A\x1b[2Ksecond\r\n") });

    expect(rawLog("sh-1")).toBe("first\r\n\x1b[1A\x1b[2Ksecond\r\n");
    disposeLog("sh-1");
  });

  it("streams new chunks to a grid that attached after the fact", async () => {
    await spawnLog({ sessionId: "sh-2", cwd: "/p", maxLines: 100 });
    channels[0].onmessage?.({ type: "output", data: b64("before\r\n") });

    const seen: string[] = [];
    const stop = subscribeRaw("sh-2", (chunk) => seen.push(chunk));
    channels[0].onmessage?.({ type: "output", data: b64("after\r\n") });
    stop();
    channels[0].onmessage?.({ type: "output", data: b64("ignored\r\n") });

    // Replay covers what came before; the subscription covers what came after,
    // and the two must not overlap or the grid renders history twice.
    expect(seen).toEqual(["after\r\n"]);
    expect(rawLog("sh-2")).toContain("before\r\n");
    disposeLog("sh-2");
  });

  it("a session can be respawned after it exited", async () => {
    await spawnLog({ sessionId: "dev-6", cwd: "/p", maxLines: 100 });
    channels[0].onmessage?.({ type: "exit", data: 0 });
    await spawnLog({ sessionId: "dev-6", cwd: "/p", maxLines: 100 });
    expect(calls.filter(([c]) => c === "pty_spawn")).toHaveLength(2);
    expect(logState("dev-6")?.status).toBe("running");
    disposeLog("dev-6");
  });

  it("replaces a spawn cancelled before it resolves", async () => {
    const resolvers: ((id: number) => void)[] = [];
    state.spawn = () =>
      new Promise<number>((resolve) => {
        resolvers.push(resolve);
      });

    const first = spawnLog({ sessionId: "dev-7", cwd: "/p", maxLines: 100 });
    await killLog("dev-7");
    const second = spawnLog({ sessionId: "dev-7", cwd: "/p", maxLines: 100 });

    resolvers[0]?.(1);
    await Promise.resolve();
    resolvers[1]?.(2);
    await Promise.all([first, second]);

    expect(calls.filter(([c]) => c === "pty_spawn")).toHaveLength(2);
    expect(calls.some(([c]) => c === "pty_kill")).toBe(true);
    expect(logState("dev-7")?.status).toBe("running");
    disposeLog("dev-7");
  });
});
