import { describe, expect, it, vi } from "vitest";

import { createTerminalFeed } from "@/lib/terminalFeed";

/** A fake frame scheduler: frames fire only when the test says so. */
const makeScheduler = () => {
  const frames = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (cb: () => void) => {
      const id = next++;
      frames.set(id, cb);
      return id;
    },
    cancel: (id: number) => {
      frames.delete(id);
    },
    run: (n = 1) => {
      for (let i = 0; i < n && frames.size > 0; i++) {
        const id = frames.keys().next().value!;
        const cb = frames.get(id)!;
        frames.delete(id);
        cb();
      }
    },
    pending: () => frames.size,
  };
};

describe("terminalFeed", () => {
  it("streams a 200 KB backlog, then live output after the first frame, in order", () => {
    const scheduler = makeScheduler();
    const seen: string[] = [];
    const feed = createTerminalFeed(
      (data) => seen.push(data),
      scheduler.schedule,
      scheduler.cancel
    );

    const backlog = "a".repeat(200 * 1024);
    feed.push(backlog);
    // One frame happened (the drain is at most one chunk behind it) and the
    // live line arrived between frames — it must queue behind the backlog.
    scheduler.run(1);
    feed.push("live\r\n");

    const written = seen.join("");
    expect(written.startsWith(backlog.slice(0, seen[0]!.length))).toBe(true);
    // Drain everything to the end.
    while (scheduler.pending() > 0) scheduler.run();
    expect(seen.join("")).toBe(backlog + "live\r\n");
  });

  it("writes at most chunk characters per frame", () => {
    const scheduler = makeScheduler();
    const seen: string[] = [];
    const feed = createTerminalFeed(
      (data) => seen.push(data),
      scheduler.schedule,
      scheduler.cancel,
      1024
    );
    feed.push("b".repeat(10 * 1024));
    while (scheduler.pending() > 0) scheduler.run();

    expect(seen.map((s) => s.length)).toEqual(
      Array.from({ length: 10 }, () => 1024)
    );
    expect(seen.join("")).toBe("b".repeat(10 * 1024));
  });

  it("does not split a surrogate pair at the chunk boundary", () => {
    const scheduler = makeScheduler();
    const seen: string[] = [];
    // One emoji ends exactly at the boundary; a naive cut lands between its
    // surrogate halves.
    const chunk = 100;
    const body = "\u{1F600}".repeat(Math.floor(chunk / 2)); // 2 UTF-16 chars each
    const feed = createTerminalFeed(
      (data) => seen.push(data),
      scheduler.schedule,
      scheduler.cancel,
      chunk
    );
    feed.push(body);
    while (scheduler.pending() > 0) scheduler.run();

    expect(seen.join("")).toBe(body);
    // No high surrogate may end a frame — that is the split itself.
    for (const piece of seen) {
      if (piece.length === 0) continue;
      const last = piece.charCodeAt(piece.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("dispose cancels the pending frame and nothing is written after", () => {
    const scheduler = makeScheduler();
    const write = vi.fn();
    const feed = createTerminalFeed(write, scheduler.schedule, scheduler.cancel);
    feed.push("first");
    feed.dispose();
    expect(scheduler.pending()).toBe(0);
    scheduler.run();
    expect(write).not.toHaveBeenCalled();
  });
});
