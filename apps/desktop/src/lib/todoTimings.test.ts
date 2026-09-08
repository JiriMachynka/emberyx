import { describe, expect, it } from "vitest";
import { MAX_PLANS, recordTodoTimings, type TimingStore } from "./todoTimings";
import type { TodoItem } from "./toolDisplay";

const item = (status: TodoItem["status"], text: string): TodoItem => ({ status, text });

describe("recordTodoTimings", () => {
  it("starts a clock when a task begins and stops it when it completes", () => {
    const store: TimingStore = new Map();
    recordTodoTimings(store, "t1", [item("in_progress", "a")], 1000);
    const plan = recordTodoTimings(store, "t1", [item("completed", "a")], 4000);
    expect(plan.get(0)).toEqual({ startedAt: 1000, endedAt: 4000 });
  });

  // The record has to outlive the component: the transcript is virtualized, so
  // the card that watched the transition is gone by the time it is read.
  it("survives being read by a later caller", () => {
    const store: TimingStore = new Map();
    recordTodoTimings(store, "t1", [item("in_progress", "a")], 1000);
    recordTodoTimings(store, "t1", [item("completed", "a")], 2500);
    const later = recordTodoTimings(store, "t1", [item("completed", "a")], 9000);
    expect(later.get(0)).toEqual({ startedAt: 1000, endedAt: 2500 });
  });

  // Rewording a task in place is the same task; a text-keyed record read it as
  // a new one and restarted the clock.
  it("keeps the clock when a task is reworded in place", () => {
    const store: TimingStore = new Map();
    recordTodoTimings(store, "t1", [item("in_progress", "Add test")], 1000);
    const plan = recordTodoTimings(
      store,
      "t1",
      [item("completed", "Add test for the parser")],
      3000
    );
    expect(plan.get(0)).toEqual({ startedAt: 1000, endedAt: 3000 });
  });

  it("gives two tasks with the same text their own clocks", () => {
    const store: TimingStore = new Map();
    recordTodoTimings(store, "t1", [item("in_progress", "run tests"), item("pending", "run tests")], 1000);
    const plan = recordTodoTimings(
      store,
      "t1",
      [item("completed", "run tests"), item("in_progress", "run tests")],
      2000
    );
    expect(plan.get(0)).toEqual({ startedAt: 1000, endedAt: 2000 });
    expect(plan.get(1)).toEqual({ startedAt: 2000 });
  });

  it("keeps each turn's plan apart", () => {
    const store: TimingStore = new Map();
    recordTodoTimings(store, "t1", [item("in_progress", "a")], 1000);
    const other = recordTodoTimings(store, "t2", [item("in_progress", "a")], 5000);
    expect(other.get(0)).toEqual({ startedAt: 5000 });
    expect(store.get("t1")?.get(0)).toEqual({ startedAt: 1000 });
  });

  // Reopening a finished task is new work; adding the spans would report time
  // the agent spent somewhere else.
  it("restarts the clock for a task that goes back in progress", () => {
    const store: TimingStore = new Map();
    recordTodoTimings(store, "t1", [item("in_progress", "a")], 1000);
    recordTodoTimings(store, "t1", [item("completed", "a")], 2000);
    const plan = recordTodoTimings(store, "t1", [item("in_progress", "a")], 8000);
    expect(plan.get(0)).toEqual({ startedAt: 8000 });
  });

  it("drops the oldest plan past the cap", () => {
    const store: TimingStore = new Map();
    for (let i = 0; i <= MAX_PLANS; i++) {
      recordTodoTimings(store, `t${i}`, [item("in_progress", "a")], i);
    }
    expect(store.size).toBe(MAX_PLANS);
    expect(store.has("t0")).toBe(false);
    expect(store.has(`t${MAX_PLANS}`)).toBe(true);
  });
});
