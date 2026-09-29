import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const {
  clearPrefetchedPages,
  fetchThreadPage,
  loadThreadHistory,
  prefetchThreadPage,
  takePrefetchedPage,
} = await import("./threadPage");

const page = (rows: number) => ({
  rows: Array.from({ length: rows }, (_, i) => ({
    messageId: `m${i}`,
    threadId: "t1",
    role: "user",
    text: "",
    createdAt: i,
    payloadJson: "{}",
  })),
  hasMore: false,
  activities: [],
});

beforeEach(() => {
  clearPrefetchedPages();
  invoke.mockReset();
  invoke.mockResolvedValue(page(1));
  vi.useRealTimers();
});

describe("fetchThreadPage", () => {
  it("asks for the freshness pass unless told not to", async () => {
    await fetchThreadPage("/repo", "t1");
    expect(invoke).toHaveBeenCalledWith(
      "thread_messages_page",
      expect.objectContaining({ cwd: "/repo", threadId: "t1", fresh: true })
    );
    await fetchThreadPage("/repo", "t1", { fresh: false });
    expect(invoke).toHaveBeenLastCalledWith(
      "thread_messages_page",
      expect.objectContaining({ fresh: false })
    );
  });
});

describe("loadThreadHistory", () => {
  const row = (id: string, createdAt: number) => ({
    messageId: id,
    threadId: "t1",
    role: "user",
    text: id,
    createdAt,
    payloadJson: "{}",
  });

  const whole = { rows: [row("m2", 2000), row("m5", 5000)], hasMore: false, activities: [] };

  it("reads the whole thread in one Rust drain", async () => {
    invoke.mockResolvedValueOnce(whole);
    const page = await loadThreadHistory("/repo", "t1");
    expect(page).toBe(whole);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("thread_history", {
      cwd: "/repo",
      threadId: "t1",
      fresh: false,
    });
  });

  it("serves a prefetched page that already holds the whole thread", async () => {
    const head = { rows: [row("m5", 5000)], hasMore: false, activities: [] };
    const page = await loadThreadHistory("/repo", "t1", Promise.resolve(head));
    expect(page).toBe(head);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drains when the prefetched page is only the tail", async () => {
    invoke.mockResolvedValueOnce(whole);
    const head = { rows: [row("m5", 5000)], hasMore: true, activities: [] };
    const page = await loadThreadHistory("/repo", "t1", Promise.resolve(head));
    expect(page).toBe(whole);
  });

  it("retries a hover prefetch that failed instead of failing the open", async () => {
    invoke.mockResolvedValueOnce(whole);
    const page = await loadThreadHistory("/repo", "t1", Promise.reject(new Error("boom")));
    expect(page).toBe(whole);
  });
});

describe("prefetchThreadPage", () => {
  it("skips the freshness pass — the pane refreshes after it paints", () => {
    prefetchThreadPage("/repo", "t1");
    expect(invoke).toHaveBeenCalledWith(
      "thread_messages_page",
      expect.objectContaining({ fresh: false })
    );
  });

  it("reuses one request for repeated hovers on the same row", () => {
    prefetchThreadPage("/repo", "t1");
    prefetchThreadPage("/repo", "t1");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("hands the page to the pane that opens it, once", async () => {
    prefetchThreadPage("/repo", "t1");
    const taken = takePrefetchedPage("/repo", "t1");
    expect(taken).toBeDefined();
    expect((await taken!).rows).toHaveLength(1);
    // Consumed: a second mount must read the log again rather than replay this.
    expect(takePrefetchedPage("/repo", "t1")).toBeUndefined();
  });

  it("keeps threads apart", async () => {
    invoke.mockResolvedValueOnce(page(2)).mockResolvedValueOnce(page(3));
    prefetchThreadPage("/repo", "t1");
    prefetchThreadPage("/repo", "t2");
    expect((await takePrefetchedPage("/repo", "t1")!).rows).toHaveLength(2);
    expect((await takePrefetchedPage("/repo", "t2")!).rows).toHaveLength(3);
  });

  it("ignores a stale page rather than painting yesterday's history", () => {
    vi.useFakeTimers();
    prefetchThreadPage("/repo", "t1");
    vi.advanceTimersByTime(20_000);
    expect(takePrefetchedPage("/repo", "t1")).toBeUndefined();
  });

  it("drops a failed prefetch so the open retries it", async () => {
    invoke.mockRejectedValueOnce(new Error("no store"));
    prefetchThreadPage("/repo", "t1");
    await Promise.resolve();
    await Promise.resolve();
    expect(takePrefetchedPage("/repo", "t1")).toBeUndefined();
  });

  it("bounds what a scroll down a long list can pin", async () => {
    for (let i = 0; i < 12; i++) prefetchThreadPage("/repo", `t${i}`);
    // The oldest hovers are evicted; the newest are still there.
    expect(takePrefetchedPage("/repo", "t0")).toBeUndefined();
    expect(takePrefetchedPage("/repo", "t11")).toBeDefined();
  });

  it("does nothing without a project or a thread", () => {
    prefetchThreadPage("", "t1");
    prefetchThreadPage("/repo", "");
    expect(invoke).not.toHaveBeenCalled();
  });
});
