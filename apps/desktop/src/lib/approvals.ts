/**
 * Approvals that outlive the window.
 *
 * An `ask_user` call blocks in Rust and is announced once, as an event. If the
 * pane was not mounted to hear it — the window was closed, the tab was not
 * open — the agent sits blocked until it times out with nobody showing the
 * question. The supervisor keeps the open requests, so a pane reads them back
 * on mount and picks the prompt up where it was left.
 */

import { invoke } from "@tauri-apps/api/core";
import type { AskQuestion, PendingAsk } from "@/hooks/useAgentChat";

export interface PendingApproval {
  approvalId: string;
  threadId: string;
  /** `ask` for an `ask_user` question, `permission` for a tool request. */
  kind: string;
  /** Opaque to the supervisor — for `ask`, the original `ask-user` payload. */
  payload: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Read an open `ask` request back into the shape the pane renders. Returns null
 * for anything that isn't an answerable question — a request whose payload no
 * longer parses is one the pane must not offer an answer for.
 */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isOption = (v: unknown): v is AskQuestion["options"][number] =>
  isRecord(v) && typeof v.label === "string";

/**
 * `AskQuestion` promises at least one option, and the picker dereferences that
 * promise — `options[active]` during render, `% options.length` on an arrow
 * key. A question with none crashes the pane, so the shape is checked at the
 * boundary rather than trusted. Applies to the live event too, not just the
 * read-back: payloads written by an older runtime are the likely bad case.
 */
export const isAskQuestion = (v: unknown): v is AskQuestion =>
  isRecord(v) &&
  typeof v.question === "string" &&
  Array.isArray(v.options) &&
  v.options.length > 0 &&
  v.options.every(isOption);

/** Validate an `ask-user` payload into the shape the picker can render. */
export function askQuestions(value: unknown): AskQuestion[] | null {
  if (!isRecord(value)) return null;
  const { questions } = value;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  if (!questions.every(isAskQuestion)) return null;
  return questions;
}

export function askFromApproval(approval: PendingApproval): PendingAsk | null {
  if (approval.kind !== "ask") return null;
  try {
    const questions = askQuestions(JSON.parse(approval.payload));
    if (!questions) return null;
    return { id: approval.approvalId, questions };
  } catch {
    return null;
  }
}

/** The oldest question this thread is still blocked on, if any. */
export async function fetchPendingAsk(threadId: string): Promise<PendingAsk | null> {
  try {
    const pending = await invoke<PendingApproval[]>("agent_approvals_pending", {
      threadId,
    });
    if (!Array.isArray(pending)) return null;
    for (const approval of pending) {
      const ask = askFromApproval(approval);
      if (ask) return ask;
    }
    return null;
  } catch {
    // An older runtime without the command simply has nothing pending.
    return null;
  }
}
