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
 *  Open while a thought or tool is still running so the current work is on
 *  screen; close as soon as that work finishes (the answer can start without
 *  burying a wall of cards). Running subagents keep it open. */
export function workLogOpen(opts: {
  live: boolean;
  working: boolean;
  agentsRunning: number;
  override: boolean | null;
}): boolean {
  if (opts.override != null) return opts.override;
  if (opts.agentsRunning > 0) return true;
  return opts.live && opts.working;
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

