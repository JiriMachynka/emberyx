/**
 * The one duration format — the live "Working for" clock, the sidebar card,
 * "Thought for" and task timings all read it, so the same turn never shows two
 * spellings of its own length. Whole seconds under a minute, then
 * unit-labelled parts — `9m 54s`, `1h 12m`. Pure, so the rule is testable
 * without a ticker.
 *
 * Floors rather than rounds: a live clock that rounded would read `3s` at
 * 2.5s, and the settled label must end on the number the clock last showed.
 *
 * The parts carry their units rather than reading `9:54`: a clock face is what
 * a timestamp looks like, and this is a duration.
 */
export const formatDuration = (ms: number): string => {
  const whole = Math.floor(Math.max(0, ms / 1000));
  if (whole < 60) return `${whole}s`;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  // Past an hour the seconds are noise on a line that keeps repainting, so the
  // smaller unit drops off rather than flickering.
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${whole % 60}s`;
};
