import { beforeEach, describe, expect, it } from "vitest";
import {
  clearThreadMeta,
  deriveThreadState,
  getAllThreadMeta,
  getThreadMeta,
  setThreadMeta,
  snoozeUntil,
  threadMetaKey,
  type ThreadMeta,
} from "@/lib/threadMeta";

beforeEach(() => {
  localStorage.clear();
});

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const daysAgo = (n: number) => (NOW - n * 86_400_000) / 1000;

const state = (meta: ThreadMeta, modified: number, merged = false) =>
  deriveThreadState({ modified, meta, now: NOW, settleDays: 3, merged });

describe("deriveThreadState", () => {
  it("keeps a recently touched thread active", () => {
    expect(state({}, daysAgo(0))).toBe("active");
    expect(state({}, daysAgo(2))).toBe("active");
  });

  it("settles a thread that has been idle for the configured days", () => {
    expect(state({}, daysAgo(3))).toBe("settled");
    expect(state({}, daysAgo(30))).toBe("settled");
  });

  it("settles a thread whose branch was merged, however fresh it is", () => {
    expect(state({}, daysAgo(0), true)).toBe("settled");
  });

  it("never auto-settles when the idle rule is switched off", () => {
    const off = { modified: daysAgo(90), meta: {}, now: NOW, settleDays: 0 };
    expect(deriveThreadState(off)).toBe("active");
  });

  it("lets a manual decision outrank both automatic rules", () => {
    expect(state({ settledOverride: "active" }, daysAgo(30))).toBe("active");
    expect(state({ settledOverride: "active" }, daysAgo(0), true)).toBe("active");
    expect(state({ settledOverride: "settled" }, daysAgo(0))).toBe("settled");
  });

  it("ranks archived above every other state", () => {
    const meta = {
      archivedAt: NOW,
      pinnedAt: NOW,
      settledOverride: "active" as const,
    };
    expect(state(meta, daysAgo(0))).toBe("archived");
  });

  it("ranks pinned above snoozed, merged, and idle", () => {
    expect(state({ pinnedAt: NOW }, daysAgo(30))).toBe("pinned");
    expect(state({ pinnedAt: NOW, snoozedUntil: NOW + 1000 }, daysAgo(0))).toBe(
      "pinned"
    );
  });

  it("treats a snooze as over the moment it lapses", () => {
    expect(state({ snoozedUntil: NOW + 1 }, daysAgo(0))).toBe("snoozed");
    expect(state({ snoozedUntil: NOW }, daysAgo(0))).toBe("active");
    // A lapsed snooze stops hiding the thread, but doesn't stop it settling.
    expect(state({ snoozedUntil: NOW - 1 }, daysAgo(30))).toBe("settled");
  });
});

describe("the meta store", () => {
  const key = threadMetaKey("/repo", "abc");

  it("returns empty meta for a thread it has never seen", () => {
    expect(getThreadMeta(key)).toEqual({});
  });

  it("merges patches instead of replacing the entry", () => {
    setThreadMeta(key, { pinnedAt: 1 });
    setThreadMeta(key, { snoozedUntil: 2 });
    expect(getThreadMeta(key)).toEqual({ pinnedAt: 1, snoozedUntil: 2 });
  });

  it("stores a linked PR and clears it", () => {
    const pr = {
      host: "github" as const,
      iid: 12,
      url: "https://github.com/acme/app/pull/12",
    };
    setThreadMeta(key, { linkedPr: pr });
    expect(getThreadMeta(key).linkedPr).toEqual(pr);
    setThreadMeta(key, { linkedPr: undefined });
    expect(getThreadMeta(key)).toEqual({});
  });

  it("clears a field passed as undefined, and drops an emptied entry", () => {
    setThreadMeta(key, { pinnedAt: 1 });
    setThreadMeta(key, { pinnedAt: undefined });
    expect(getThreadMeta(key)).toEqual({});
    expect(getAllThreadMeta()).toEqual({});
  });

  it("keys threads by project so the same id in two repos stays separate", () => {
    setThreadMeta(threadMetaKey("/a", "same"), { pinnedAt: 1 });
    expect(getThreadMeta(threadMetaKey("/b", "same"))).toEqual({});
  });

  it("clears every field at once", () => {
    setThreadMeta(key, { pinnedAt: 1, archivedAt: 2, settledOverride: "settled" });
    clearThreadMeta(key);
    expect(getThreadMeta(key)).toEqual({});
  });

  it("survives unparseable stored data", () => {
    localStorage.setItem("emberyx.threadMeta", "{not json");
    expect(getThreadMeta(key)).toEqual({});
  });
});

describe("snoozeUntil", () => {
  it("moves an hour out", () => {
    expect(snoozeUntil.hour(NOW)).toBe(NOW + 3_600_000);
  });

  it("lands on 9am the next local day", () => {
    const d = new Date(snoozeUntil.tomorrow(NOW));
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(new Date(NOW).getDate() + 1);
  });

  it("moves a week out", () => {
    expect(snoozeUntil.week(NOW)).toBe(NOW + 7 * 86_400_000);
  });
});
