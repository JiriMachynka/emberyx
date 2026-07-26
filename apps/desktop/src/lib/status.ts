import { classify } from "@/lib/accountState";
import type { SessionStatus } from "@/types";

/**
 * Map a Claude Code hook event name to an agent status.
 *
 * @param message the Notification hook's own message, when there is one. A
 * usage limit or a lost login also arrives as a Notification, and neither is
 * the agent waiting on the user — those carry no status, so the session keeps
 * the one it had and the account banner speaks instead.
 */
export function statusForEvent(
  event: string,
  message?: string
): SessionStatus | null {
  switch (event) {
    case "UserPromptSubmit":
    case "SubagentStop":
      return "working";
    case "Notification":
      return message && classify(message) ? null : "waiting";
    case "Stop":
      return "idle";
    default:
      return null;
  }
}

/** Agent status for a session id, defaulting to idle when unknown. */
export function statusOf(
  statuses: Record<string, SessionStatus>,
  id: string
): SessionStatus {
  return statuses[id] ?? "idle";
}

export const STATUS_META: Record<
  SessionStatus,
  { label: string; text: string; pulse: boolean }
> = {
  idle: {
    label: "idle",
    text: "text-muted-foreground",
    pulse: false,
  },
  working: {
    label: "working",
    text: "text-orange-400",
    pulse: true,
  },
  waiting: {
    label: "needs you",
    text: "text-amber-400",
    pulse: true,
  },
};
