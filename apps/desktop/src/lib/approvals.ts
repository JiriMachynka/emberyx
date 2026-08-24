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
import type { PendingAsk } from "@/hooks/useAgentChat";

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
export function askFromApproval(approval: PendingApproval): PendingAsk | null {
  if (approval.kind !== "ask") return null;
  try {
    const parsed: unknown = JSON.parse(approval.payload);
    if (!parsed || typeof parsed !== "object") return null;
    const { questions } = parsed as { questions?: unknown };
    if (!Array.isArray(questions) || questions.length === 0) return null;
    return { id: approval.approvalId, questions: questions as PendingAsk["questions"] };
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
