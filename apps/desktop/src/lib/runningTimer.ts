/**
 * Format a live elapsed duration for a running row: one decimal under a
 * minute, `m:ss` past it. Pure, so the rule is testable without a ticker.
 */
export const formatRunningDuration = (ms: number): string => {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${(Math.floor(s * 10) / 10).toFixed(1)}s`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;
};
