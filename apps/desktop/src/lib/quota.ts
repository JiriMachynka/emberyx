/** Formatting for the plan-quota readout. Pure so the composer stays dumb. */

import type { ChatQuota, QuotaWindow } from "@/hooks/useAgentChat";

/** Compact length of a rolling window: 43200 minutes → "30d". */
export function formatWindowLength(mins: number | null): string {
  if (mins === null || mins <= 0) return "";
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** How long until a window rolls over. `resetsAt` is unix seconds; null when
 *  the backend reported no reset instant. */
export function formatResetsIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const mins = (resetsAt * 1000 - now) / 60_000;
  if (mins <= 0) return "resets now";
  return `resets in ${formatWindowLength(mins)}`;
}

/** Plan tier as a label: "free" → "Free". */
export function formatPlan(planType: string | null): string | null {
  if (!planType) return null;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

/** How much of a window has to be gone before the chat says so unprompted.
 *  Below this the chip in the composer is enough. */
export const QUOTA_WARN_PERCENT = 80;
export const QUOTA_CRITICAL_PERCENT = 95;

export interface QuotaAlert {
  level: "warn" | "critical" | "exhausted";
  /** Rounded used share of the window this alert is about. */
  percent: number;
  /** "5h", "7d" — the window's own length, which is how the plan describes it. */
  window: string;
  /** "resets in 2h", when the backend named a reset instant. */
  resets: string | null;
}

/**
 * The one window worth interrupting about, or `null` while there is room left.
 *
 * The tightest window wins: an account with 20% of the week gone but 96% of the
 * five hours is about to stop working, and saying "20%" would be true and
 * useless. A window the backend reports no length for still alerts — the number
 * is the point, the label is decoration.
 */
export function quotaAlert(
  quota:
    | {
        primary: { usedPercent: number; resetsAt: number | null; windowDurationMins: number | null } | null;
        secondary: { usedPercent: number; resetsAt: number | null; windowDurationMins: number | null } | null;
      }
    | undefined,
  now: number
): QuotaAlert | null {
  if (!quota) return null;
  const windows = [quota.primary, quota.secondary].filter((w) => w !== null);
  if (!windows.length) return null;
  const worst = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  const percent = Math.min(100, Math.round(worst.usedPercent));
  if (percent < QUOTA_WARN_PERCENT) return null;
  return {
    level:
      percent >= 100
        ? "exhausted"
        : percent >= QUOTA_CRITICAL_PERCENT
          ? "critical"
          : "warn",
    percent,
    window: formatWindowLength(worst.windowDurationMins),
    resets: formatResetsIn(worst.resetsAt, now),
  };
}

/** What the strip says. Phrased around the window, not the percentage, because
 *  "your 5h window" is the thing the user actually plans around. */
export function quotaMessage(alert: QuotaAlert): string {
  const window = alert.window ? `${alert.window} limit` : "usage limit";
  if (alert.level === "exhausted") return `You have used your full ${window}.`;
  return `${alert.percent}% of your ${window} is used.`;
}

/** Rolling-window lengths Claude reports, in minutes. The event names the
 *  window but not how long it is, and the chip labels itself from the length. */
const CLAUDE_WINDOW_MINS: Record<string, number> = {
  five_hour: 300,
  seven_day: 10080,
};

/** `utilization` arrives as a 0–1 fraction here, unlike the 0–100 integer the
 *  same numbers have in `~/.claude.json`. A value above 1 can only be the
 *  percent form, so both are accepted rather than silently reading 100% as 1%. */
const percentOf = (utilization: number): number =>
  utilization <= 1 ? utilization * 100 : utilization;

const claudeWindow = (value: unknown, mins: number): QuotaWindow | null => {
  if (typeof value !== "object" || value === null) return null;
  const w = value as { utilization?: unknown; resetsAt?: unknown };
  if (typeof w.utilization !== "number") return null;
  return {
    usedPercent: percentOf(w.utilization),
    resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
    windowDurationMins: mins,
  };
};

/**
 * Claude's plan windows, from the `rate_limit_event` line it emits once per
 * turn on the stream the chat already runs.
 *
 * Read here rather than polled: the CLI has an undocumented `get_usage` control
 * request that returns fresher numbers, but this line costs nothing and arrives
 * as a side effect of work the user is already doing — and the quota only moves
 * when a turn runs, which is exactly when this fires.
 *
 * No plan tier is reported on this line, so `planType` stays null; showing a
 * guessed tier next to real percentages would be the one misleading part.
 */
export function decodeClaudeQuota(msg: unknown): ChatQuota | null {
  if (typeof msg !== "object" || msg === null) return null;
  const info = (msg as { rate_limit_info?: unknown }).rate_limit_info;
  if (typeof info !== "object" || info === null) return null;
  const windows = (info as { unifiedWindows?: unknown }).unifiedWindows;
  if (typeof windows !== "object" || windows === null) return null;
  const w = windows as Record<string, unknown>;
  const primary = claudeWindow(w.five_hour, CLAUDE_WINDOW_MINS.five_hour);
  const secondary = claudeWindow(w.seven_day, CLAUDE_WINDOW_MINS.seven_day);
  if (!primary && !secondary) return null;
  return { primary, secondary, planType: null };
}
