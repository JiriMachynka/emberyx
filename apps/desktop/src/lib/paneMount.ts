import type { SessionStatus } from "@/types";

/** How many recently visited panes stay mounted behind the active one.
 *  Remounting a settled pane is not free: it respawns the CLI, re-reads the
 *  thread page and re-renders every message through markdown and Shiki with a
 *  cold memo cache — around a second on a long thread. Keeping the last few
 *  alive makes switching back instant; the bound is what stops every project's
 *  chat being parsed and held at once. */
export const PANE_KEEP_ALIVE = 3;

/**
 * A pane that is mid-turn must stay mounted when hidden. Unmounting kills the
 * process (or detaches a persistent one), and an approval that isn't on screen
 * leaves the agent blocked until its timeout.
 */
export function paneIsSticky(status: SessionStatus | undefined): boolean {
  return status === "working" || status === "waiting";
}

/**
 * Most-recently-visited first, capped at `limit`. Returns the same array when
 * `activeId` is already the head, so calling it during render is idempotent —
 * StrictMode renders twice — and doesn't churn the ref that holds it.
 */
export function pushRecent(
  recent: string[],
  activeId: string | null,
  limit = PANE_KEEP_ALIVE
): string[] {
  if (!activeId) return recent.length <= limit ? recent : recent.slice(0, limit);
  if (recent[0] === activeId && recent.length <= limit) return recent;
  return [activeId, ...recent.filter((id) => id !== activeId)].slice(0, limit);
}

export function paneShouldMount(
  sessionId: string,
  activeId: string | null,
  status: SessionStatus | undefined,
  recent: readonly string[] = []
): boolean {
  return (
    sessionId === activeId || paneIsSticky(status) || recent.includes(sessionId)
  );
}
