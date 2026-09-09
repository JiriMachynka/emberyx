/**
 * Format a live elapsed duration for a running row: one decimal under a
 * minute, then unit-labelled parts — `9m 54s`, `1h 12m`. Pure, so the rule is
 * testable without a ticker.
 *
 * The parts carry their units rather than reading `9:54`: a clock face is what
 * a timestamp looks like, and this is a duration that has been climbing since
 * the turn started.
 */
export const formatRunningDuration = (ms: number): string => {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${(Math.floor(s * 10) / 10).toFixed(1)}s`;
  const whole = Math.floor(s);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  // Past an hour the seconds are noise on a line that repaints ten times a
  // second, so the smaller unit drops off rather than flickering.
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${whole % 60}s`;
};
