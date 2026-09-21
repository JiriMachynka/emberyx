/**
 * The one shape every chat transport hands the pane.
 *
 * `useChatSession` picks between the Claude, Codex and ACP hooks, and `ChatPane`
 * consumes whichever it gets structurally — so until now the contract lived only
 * in the coincidence of three object literals. Declaring it here makes a missed
 * or mistyped field a compile error instead of a pane that renders blank, and
 * gives a fourth backend a single target to hit.
 *
 * It is a return shape, not a base class: the state machines inside stay
 * per-transport because their wire protocols genuinely differ. What is shared is
 * the *contract* and the cross-cutting machinery around it (publish throttling,
 * the prompt queue, checkpoint settle) — see the sibling modules.
 */

import type {
  ChatImage,
  ChatMessage,
  ChatStatus,
  ChatUsage,
  PendingAsk,
  PendingPermission,
  PendingPlanApproval,
  PermissionDecision,
  PlanOutcome,
} from "@/lib/chatMessage";
import type { PromptQueue } from "@/lib/promptQueue";

/** States where a turn is in flight, so a new message queues instead of
 *  starting a second turn. The union of what any transport can set — a
 *  transport that never emits a member simply never matches it, which is why
 *  Claude and ACP can share the set Codex needs for `retrying`. */
export const BUSY_STATUS: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "thinking",
  "streaming",
  "tool",
  "awaiting_permission",
  "awaiting_answer",
  "retrying",
]);

export interface ChatSession {
  messages: ChatMessage[];
  status: ChatStatus;
  usage: ChatUsage;
  /** Spawn landed and the process is writable; a held first turn may fire. */
  ready: boolean;
  /** Not started *yet*: no process is wanted until the first send. The composer
   *  must stay live in this state or the keystroke that wakes the pane can
   *  never be typed. */
  asleep: boolean;
  wake: () => void;
  /** The provider's own thread id, for the sidebar; `undefined` before a fresh
   *  agent has named one (imported history, a cold start). */
  threadId: string | undefined;
  send: (text: string, images?: ChatImage[]) => void;
  compact: () => void;
  /** Turns waiting in the runtime queue, mirrored synchronously for the footer. */
  queued: number;
  queue: PromptQueue;
  stop: () => void;
  /** Respawn in place after an error or exit, against the same thread. */
  restart: () => void;
  /** Human reason the process/turn ended — the "Session ended" explanation. */
  exitReason: string | null;
  /** Why the model the user asked for isn't running. Only ACP can refuse a
   *  switch mid-session; Claude and Codex fail their spawn/turn instead. */
  modelError: string | null;
  /** Pull back a turn that produced nothing, or `null` when it already spoke. */
  rewind: () => { text: string; images?: ChatImage[] } | null;
  revertTurn: (checkpointId: string) => Promise<void>;
  pendingPermission: PendingPermission | null;
  respond: (decision: PermissionDecision) => void;
  /** Grok's plan gate; permanent absence for the other two. */
  pendingPlan: PendingPlanApproval | null;
  answerPlan: (outcome: PlanOutcome, comments: string) => void;
  pendingAsk: PendingAsk | null;
  answerAsk: (answer: string) => void;
  /** Older transcript pages exist above the hydrated page (Claude only). */
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<boolean>;
}

// Module-level, so a pane sees the same function every render. Inline, each
// publish handed ChatPane a fresh callback, which rebuilt its `chat` object and
// re-rendered every visible turn about eight times a second.
export const chatNoop = () => {};
export const rewindNothing = () => null;
export const revertNothing = async () => {};
export const loadNothing = async () => false;
export const notifyPlanNothing = (_outcome: PlanOutcome, _comments: string) => {};
