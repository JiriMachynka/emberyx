import { classify } from "@/lib/accountState";
import { capabilitiesOf, type AgentBackend } from "@/lib/agentBackend";
import type { CodexHookEvent } from "@/lib/codex/protocol";
import type { SessionStatus } from "@/types";

/** Codex spells its hook events in camelCase and has no `Notification` — an
 *  account block never reaches the status feed this way. Listed exhaustively
 *  so a new event in the protocol fails the build rather than going silent. */
const CODEX_STATUS: Record<CodexHookEvent, SessionStatus | null> = {
  preToolUse: null,
  permissionRequest: "waiting",
  postToolUse: null,
  preCompact: null,
  postCompact: null,
  sessionStart: null,
  sessionEnd: "idle",
  userPromptSubmit: "working",
  subagentStart: "working",
  subagentStop: "working",
  stop: "idle",
};

const CODEX_LOOKUP = new Map(Object.entries(CODEX_STATUS));

/**
 * Map a hook event name to an agent status. A backend that reports no hook
 * status yields none, and each backend's event names are its own: Claude's
 * arrive over the local hook server, Codex's in-band on the app-server.
 *
 * @param message the Notification hook's own message, when there is one. A
 * usage limit or a lost login also arrives as a Notification, and neither is
 * the agent waiting on the user — those carry no status, so the session keeps
 * the one it had and the account banner speaks instead.
 */
export function statusForEvent(
  event: string,
  message?: string,
  backend: AgentBackend = "claude"
): SessionStatus | null {
  if (!capabilitiesOf(backend).hookStatus) return null;
  if (backend === "codex") return CODEX_LOOKUP.get(event) ?? null;
  switch (event) {
    case "UserPromptSubmit":
    case "SubagentStop":
      return "working";
    case "Notification":
      return message && classify(message, backend) ? null : "waiting";
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
