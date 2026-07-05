import type { SessionStatus } from "@/types";

/** Map a Claude Code hook event name to an agent status. */
export function statusForEvent(event: string): SessionStatus | null {
  switch (event) {
    case "UserPromptSubmit":
    case "SubagentStop":
      return "working";
    case "Notification":
      return "waiting";
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
  { label: string; dot: string; text: string; pulse: boolean }
> = {
  idle: {
    label: "idle",
    dot: "bg-zinc-500",
    text: "text-muted-foreground",
    pulse: false,
  },
  working: {
    label: "working",
    dot: "bg-sky-500",
    text: "text-sky-400",
    pulse: true,
  },
  waiting: {
    label: "needs you",
    dot: "bg-amber-500",
    text: "text-amber-400",
    pulse: true,
  },
};
