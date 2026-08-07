/**
 * Moving context between the two agent CLIs. A handoff prefills the other
 * backend's composer in the same project — it never sends, so the user always
 * gets the last word on what the second agent is asked.
 */

import { BACKEND_LABEL, type AgentBackend } from "@/lib/agentBackend";
import type { Session } from "@/types";

export const otherBackend = (backend: AgentBackend): AgentBackend =>
  backend === "claude" ? "codex" : "claude";

export const handoffLabel = (from: AgentBackend): string =>
  `Hand off to ${BACKEND_LABEL[otherBackend(from)]}`;

/** The project's live chat on the target backend. Reused rather than opened
 *  again, or every handed-off message would stack another tab. */
export const findHandoffTarget = (
  sessions: Session[],
  projectId: string,
  backend: AgentBackend
): Session | undefined =>
  sessions.find(
    (s) => s.projectId === projectId && s.kind === "chat" && s.backend === backend
  );

/** The text that lands in the target composer: the message, plus the working
 *  tree's diff when one was attached. */
export const buildHandoffPayload = (
  from: AgentBackend,
  text: string,
  diff?: string
): string => {
  const head = `Context from ${BACKEND_LABEL[from]}:\n\n${text.trim()}`;
  const body = diff?.trim();
  return body ? `${head}\n\nUncommitted changes:\n\n\`\`\`diff\n${body}\n\`\`\`` : head;
};
