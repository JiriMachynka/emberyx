import type { SessionStatus } from "@/types";

/**
 * A pane that is mid-turn must stay mounted when hidden. Unmounting kills the
 * process (or detaches a persistent one), and an approval that isn't on screen
 * leaves the agent blocked until its timeout. Settled panes remount from a
 * windowed transcript, so they do not need to stay alive.
 */
export function paneIsSticky(status: SessionStatus | undefined): boolean {
  return status === "working" || status === "waiting";
}

export function paneShouldMount(
  sessionId: string,
  activeId: string | null,
  status: SessionStatus | undefined
): boolean {
  return sessionId === activeId || paneIsSticky(status);
}
