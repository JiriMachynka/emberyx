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

export const isAgentTool = (name: string): boolean => name === "Task" || name === "Agent";

/** Default open state of a turn's work log, before the user clicks.
 *  Live work stays open until the answer starts; running subagents keep it
 *  open so their log isn't buried under the answer. */
export function workLogOpen(opts: {
  live: boolean;
  answering: boolean;
  agentsRunning: number;
  override: boolean | null;
}): boolean {
  if (opts.override != null) return opts.override;
  if (opts.agentsRunning > 0) return true;
  return opts.live && !opts.answering;
}

/** Hide the work-log title while live work is already on screen — that title
 *  used to say "Thinking" and then list the running command underneath. */
export function workLogHeaderVisible(opts: {
  live: boolean;
  expanded: boolean;
  agentsRunning: number;
}): boolean {
  if (opts.agentsRunning > 0) return true;
  return !(opts.live && opts.expanded);
}

