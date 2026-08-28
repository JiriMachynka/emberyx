/**
 * Turn grouping and the small formatters the transcript needs. Pure, so the
 * rules that decide where one turn ends and the next begins are testable
 * without mounting a pane.
 */

import type { ChatMessage } from "@/hooks/useAgentChat";

export interface Turn {
  key: string;
  user: ChatMessage | null;
  assistants: ChatMessage[];
}

/** Split the flat message list into turns: a user message and the assistant
 *  messages that answer it, up to the next user message. */
export function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      cur = { key: m.id, user: m, assistants: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { key: m.id, user: null, assistants: [] };
        turns.push(cur);
      }
      cur.assistants.push(m);
    }
  }
  return turns;
}

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const isAgentTool = (name: string): boolean => name === "Task" || name === "Agent";

