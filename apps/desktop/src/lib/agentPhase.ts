/**
 * What a running agent is doing right now, in a few words — "Running bun
 * test", "Editing ChatPane.tsx", "Needs approval". The sidebar row and the
 * thread's working footer both read it, so they never describe one run two
 * ways.
 *
 * Built from the provider-neutral activity stream every transport already
 * produces, so it means the same thing for Claude, Codex, OpenCode and Grok.
 * Nothing here is inferred from text: no running row means a plain verb.
 */

import type { ChatMessage, ChatStatus } from "@/lib/chatMessage";
import { basename } from "@/lib/path";
import type { ActivityItem } from "@/types";

export interface AgentPhase {
  /** `waiting` is the agent blocked on the user — it reads differently from
   *  work, because it is the one state only the user can end. */
  tone: "working" | "waiting";
  label: string;
}

const describe = (a: ActivityItem): string => {
  const target = a.displayTarget?.trim();
  switch (a.kind) {
    case "reasoning":
      return "Thinking";
    case "command":
      return target ? `Running ${target}` : "Running a command";
    case "fileChange":
      return target ? `Editing ${basename(target)}` : "Editing files";
    case "fileRead":
      return target ? `Reading ${basename(target)}` : "Reading files";
    case "fileSearch":
    case "search":
      return target ? `Searching ${target}` : "Searching";
    case "fileList":
      return target ? `Listing ${basename(target)}` : "Listing files";
    case "plan":
      return "Planning";
    case "tool":
      return a.title || "Using a tool";
  }
};

/** The phase for a chat status and the message being written, or null when
 *  the agent isn't running. The latest unfinished row wins — rows arrive in
 *  order, so that is the work happening now. */
export const agentPhase = (
  status: ChatStatus,
  draft: ChatMessage | null | undefined
): AgentPhase | null => {
  if (status === "awaiting_permission") return { tone: "waiting", label: "Needs approval" };
  if (status === "awaiting_answer") return { tone: "waiting", label: "Asked a question" };
  if (status === "retrying") return { tone: "working", label: "Retrying" };
  if (status !== "thinking" && status !== "streaming" && status !== "tool") return null;
  const rows = draft?.activities ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].complete) return { tone: "working", label: describe(rows[i]) };
  }
  return { tone: "working", label: status === "streaming" ? "Responding" : "Thinking" };
};

export const samePhase = (a: AgentPhase | null, b: AgentPhase | null): boolean =>
  a === b || (a != null && b != null && a.tone === b.tone && a.label === b.label);
