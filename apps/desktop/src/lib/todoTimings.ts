/**
 * How long each task in a plan took.
 *
 * The tool payload carries no clocks, so the only way to know is to watch the
 * statuses change — which means the record has to outlive the component. The
 * transcript is virtualized: a card that stored its own timings lost every one
 * of them the moment its row scrolled out and remounted, so a settled turn's
 * plan showed no durations at all.
 *
 * Tasks are keyed by their **position** in the plan, not their text. An agent
 * rewords a task in place ("Add test" → "Add test for the parser") and a
 * text-keyed record reads that as a new task and restarts its clock.
 */

import type { TodoItem } from "@/lib/toolDisplay";

export interface TodoTiming {
  startedAt: number;
  endedAt?: number;
}

/** Position in the plan → when that task ran. */
export type PlanTimings = Map<number, TodoTiming>;

export type TimingStore = Map<string, PlanTimings>;

/** Plans kept before the oldest is dropped. A session has a handful; the cap
 *  only exists so a long-lived window cannot grow this without bound. */
export const MAX_PLANS = 200;

/**
 * Fold a plan's current statuses into `store` and return that plan's timings.
 *
 * A task that goes back to `in_progress` after finishing starts a fresh clock —
 * an agent that reopens a task is doing new work, and adding the two spans
 * would report time it spent elsewhere.
 */
export function recordTodoTimings(
  store: TimingStore,
  planKey: string,
  items: readonly TodoItem[],
  now: number
): PlanTimings {
  let plan = store.get(planKey);
  if (!plan) {
    plan = new Map();
    if (store.size >= MAX_PLANS) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    store.set(planKey, plan);
  }
  items.forEach((item, index) => {
    const prev = plan.get(index);
    if (item.status === "in_progress") {
      if (!prev || prev.endedAt != null) plan.set(index, { startedAt: now });
    } else if (item.status === "completed" && prev && prev.endedAt == null) {
      plan.set(index, { startedAt: prev.startedAt, endedAt: now });
    }
  });
  return plan;
}

/** The one store the app shares, so a remounted card reads what it recorded
 *  before it was unmounted. */
export const todoTimings: TimingStore = new Map();
