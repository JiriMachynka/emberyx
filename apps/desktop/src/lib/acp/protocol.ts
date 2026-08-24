/**
 * Agent Client Protocol wire types, narrowed to what the chat pane consumes.
 *
 * Written against the published ACP schema and checked against the installed
 * `opencode` (1.18.21), which negotiates `protocolVersion: 1`. Where v1 and the
 * v2 draft disagree, both spellings are accepted and noted at the decoder —
 * OpenCode, Grok and Kilo are not all on the same revision.
 */

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpContentBlock {
  type: string;
  text?: string;
  content?: AcpContentBlock;
}

export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolStatus;
  content?: AcpContentBlock[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpPlanEntry {
  content: string;
  priority?: string;
  status?: string;
}

/** v1 carries `entries` inline; the v2 draft nests them under `plan`. */
export interface AcpPlanUpdate {
  sessionUpdate: "plan" | "plan_update";
  entries?: AcpPlanEntry[];
  plan?: { entries?: AcpPlanEntry[] };
}

export interface AcpChunkUpdate {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
  content?: AcpContentBlock;
}

export type AcpUpdate =
  | AcpChunkUpdate
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | { sessionUpdate: string };

/** `session/update` params. */
export interface AcpSessionUpdate {
  sessionId: string;
  update: AcpUpdate;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  /** allow_once | allow_always | reject_once | reject_always, plus custom. */
  kind?: string;
}

/** `session/request_permission` params. The agent blocks until answered. */
export interface AcpPermissionRequest {
  sessionId: string;
  title?: string;
  description?: string;
  options: AcpPermissionOption[];
  /** v1 puts the tool call here… */
  toolCall?: { toolCallId?: string; title?: string; kind?: string };
  /** …the v2 draft wraps it in a tagged subject. */
  subject?: {
    type: string;
    toolCall?: { toolCallId?: string; title?: string; kind?: string };
  };
}

/** Why a turn stopped, from `session/prompt`'s reply. */
export type AcpStopReason =
  | "end_turn"
  | "cancelled"
  | "refusal"
  | "max_tokens"
  | "max_turn_requests";

/** One `configOptions` entry from `session/new` — the model catalog lives here
 *  rather than in a hand-written table. */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
}
