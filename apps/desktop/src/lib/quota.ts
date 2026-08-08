/** Formatting for the plan-quota readout. Pure so the composer stays dumb. */

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
