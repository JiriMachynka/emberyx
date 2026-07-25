import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_NOTIFICATIONS,
  loadNotifications,
  saveNotifications,
  type AppNotification,
} from "@/lib/notifications";

beforeEach(() => {
  localStorage.clear();
});

const make = (id: string, over: Partial<AppNotification> = {}): AppNotification => ({
  id,
  session: "s1",
  project: "emberyx",
  kind: "done",
  title: "Task finished",
  body: "All tests pass",
  time: 1,
  read: false,
  ...over,
});

describe("notifications", () => {
  it("starts empty", () => {
    expect(loadNotifications()).toEqual([]);
  });

  it("round-trips a saved list", () => {
    const list = [make("a"), make("b", { kind: "error", read: true })];
    saveNotifications(list);
    expect(loadNotifications()).toEqual(list);
  });

  it("recovers from corrupt storage", () => {
    localStorage.setItem("emberyx.notifications", "{not json");
    expect(loadNotifications()).toEqual([]);
  });

  it("recovers from a stored value of the wrong shape", () => {
    localStorage.setItem("emberyx.notifications", JSON.stringify({ list: [] }));
    expect(loadNotifications()).toEqual([]);
  });

  it("filters out entries missing required fields", () => {
    localStorage.setItem(
      "emberyx.notifications",
      JSON.stringify([
        make("ok"),
        { ...make("no-session"), session: undefined },
        { ...make("no-time"), time: "yesterday" },
        { ...make("bad-kind"), kind: "warning" },
        null,
        "nope",
      ])
    );
    expect(loadNotifications().map((n) => n.id)).toEqual(["ok"]);
  });

  it("caps the stored list at MAX_NOTIFICATIONS, keeping the newest", () => {
    const list = Array.from({ length: MAX_NOTIFICATIONS + 50 }, (_, i) =>
      make(`n${i}`, { time: MAX_NOTIFICATIONS + 50 - i })
    );
    saveNotifications(list);
    const stored = loadNotifications();
    expect(stored).toHaveLength(MAX_NOTIFICATIONS);
    expect(stored[0].id).toBe("n0");
    expect(stored[stored.length - 1].id).toBe(`n${MAX_NOTIFICATIONS - 1}`);
  });
});
