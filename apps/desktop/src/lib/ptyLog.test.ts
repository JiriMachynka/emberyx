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
  rawLog,
  resizeLog,
  spawnLog,
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
  it("spawns and buffers output", async () => {
    await spawnLog({ sessionId: "dev-1", cwd: "/p", command: "bun dev" });

    expect(calls.map(([c]) => c)).toContain("pty_spawn");
    channels[0].onmessage?.({ type: "output", data: b64("ready on :3000\n") });

    expect(rawLog("dev-1")).toBe("ready on :3000\n");
    disposeLog("dev-1");
  });

  it("applies a size requested while the spawn is still in flight", async () => {
    let resolveSpawn: ((id: number) => void) | null = null;
    state.spawn = () => new Promise<number>((res) => (resolveSpawn = res));
    const spawning = spawnLog({ sessionId: "sh-size", cwd: "/p" });

    await resizeLog("sh-size", 97, 31);
    expect(calls.filter(([c]) => c === "pty_resize")).toHaveLength(0);

    resolveSpawn!(7);
    await spawning;

    expect(calls).toContainEqual(["pty_resize", { id: 7, cols: 97, rows: 31 }]);
    disposeLog("sh-size");
  });

  it("spawns at the size a previous view measured", async () => {
    await spawnLog({ sessionId: "sh-resize", cwd: "/p" });
    await resizeLog("sh-resize", 120, 40);
    channels[0].onmessage?.({ type: "exit", data: 0 });
    await spawnLog({ sessionId: "sh-resize", cwd: "/p" });

    const spawns = calls.filter(([c]) => c === "pty_spawn");
    expect(spawns[1][1]).toMatchObject({ cols: 120, rows: 40 });
    disposeLog("sh-resize");
  });

  it("does not spawn a second PTY for a live session", async () => {
    await spawnLog({ sessionId: "dev-2", cwd: "/p" });
    await spawnLog({ sessionId: "dev-2", cwd: "/p" });
    expect(calls.filter(([c]) => c === "pty_spawn")).toHaveLength(1);
    disposeLog("dev-2");
  });

  it("fires the onExit callback on exit", async () => {
    const exits: (number | null)[] = [];
    await spawnLog({
      sessionId: "dev-3",
      cwd: "/p",
      onExit: (code) => exits.push(code),
    });
    channels[0].onmessage?.({ type: "exit", data: 1 });

    expect(exits).toEqual([1]);
    disposeLog("dev-3");
  });

  it("kill sends pty_kill and forgets the buffer", async () => {
    await spawnLog({ sessionId: "dev-4", cwd: "/p" });
    await killLog("dev-4");

    expect(calls.some(([c, a]) => c === "pty_kill" && a.id === 1)).toBe(true);
    expect(rawLog("dev-4")).toBe("");
  });

  it("assembles output split across events", async () => {
    await spawnLog({ sessionId: "dev-5", cwd: "/p" });
    channels[0].onmessage?.({ type: "output", data: b64("a\x1b[3") });
    channels[0].onmessage?.({ type: "output", data: b64("1mred\x1b[0m\n") });
    expect(rawLog("dev-5")).toBe("a\x1b[31mred\x1b[0m\n");
    disposeLog("dev-5");
  });

  it("keeps the raw stream for a terminal grid, escape sequences intact", async () => {
    // A VT needs exactly what the child wrote — this is a cursor-up redraw,
    // the shape that made p10k draw twice once anything normalised the stream.
    await spawnLog({ sessionId: "sh-1", cwd: "/p" });
    channels[0].onmessage?.({ type: "output", data: b64("first\r\n") });
    channels[0].onmessage?.({ type: "output", data: b64("\x1b[1A\x1b[2Ksecond\r\n") });

    expect(rawLog("sh-1")).toBe("first\r\n\x1b[1A\x1b[2Ksecond\r\n");
    disposeLog("sh-1");
  });

  it("streams new chunks to a grid that attached after the fact", async () => {
    await spawnLog({ sessionId: "sh-2", cwd: "/p" });
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
    await spawnLog({ sessionId: "dev-6", cwd: "/p" });
    channels[0].onmessage?.({ type: "exit", data: 0 });
    await spawnLog({ sessionId: "dev-6", cwd: "/p" });
    expect(calls.filter(([c]) => c === "pty_spawn")).toHaveLength(2);
    disposeLog("dev-6");
  });

  it("replaces a spawn cancelled before it resolves", async () => {
    const resolvers: ((id: number) => void)[] = [];
    state.spawn = () =>
      new Promise<number>((resolve) => {
        resolvers.push(resolve);
      });

    const first = spawnLog({ sessionId: "dev-7", cwd: "/p" });
    await killLog("dev-7");
    const second = spawnLog({ sessionId: "dev-7", cwd: "/p" });

    resolvers[0]?.(1);
    await Promise.resolve();
    resolvers[1]?.(2);
    await Promise.all([first, second]);

    expect(calls.filter(([c]) => c === "pty_spawn")).toHaveLength(2);
    expect(calls.some(([c]) => c === "pty_kill")).toBe(true);
    disposeLog("dev-7");
  });
});
