/**
 * Normalises ACP `session/update` notifications into the message model the chat
 * pane already renders. Pure and synchronous: the hook owns the process, the
 * channel and React state; everything about *what a frame means* lives here.
 *
 * ACP streams an assistant turn as independent chunks (message text, thoughts,
 * tool calls keyed by `toolCallId`, a plan), while the pane expects one
 * assistant message per turn carrying text, thinking and tool calls. Tool calls
 * are upserts by id, exactly as the spec describes them.
 *
 * A plan arrives as its own update kind. It is a list of steps with a status
 * each, so it is normalized to the `TodoWrite` task list — the same shape the
 * Codex adapter maps `turn/plan/updated` to, rather than a second rendering of
 * the same idea.
 */

import type { ChatMessage, ChatStatus, ToolCall } from "@/hooks/useAgentChat";
import type {
  AcpContentBlock,
  AcpPermissionRequest,
  AcpPlanEntry,
  AcpStopReason,
  AcpToolCallUpdate,
  AcpUpdate,
} from "./protocol";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Flatten a content block to text; nested blocks carry their own `content`. */
export function blockText(block: AcpContentBlock | undefined): string {
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  if (block.content) return blockText(block.content);
  return "";
}

export const planToolId = (planKey: string) => `acp-plan-${planKey}`;

/** Which plan an update is about. v2 gives a plan its own id; v1 has one plan
 *  per session, so everything without an id is the same plan being revised. */
export function planKeyOf(update: unknown): string {
  const plan = isRecord(update) && isRecord(update.plan) ? update.plan : null;
  const id = plan?.planId ?? plan?.id;
  return typeof id === "string" ? id : "0";
}

/** A plan rendered as the task list the pane already draws for both CLIs. */
export function planTool(entries: AcpPlanEntry[], planKey: string): ToolCall {
  const todos = entries.map((e) => ({
    content: e.content,
    status: e.status === "completed" || e.status === "in_progress" ? e.status : "pending",
  }));
  return {
    id: planToolId(planKey),
    name: "TodoWrite",
    input: { todos },
    partial: "",
  };
}

/** Plan entries from either revision's shape. */
export const planEntriesOf = (update: unknown): AcpPlanEntry[] | null => {
  if (!isRecord(update)) return null;
  const kind = update.sessionUpdate;
  if (kind !== "plan" && kind !== "plan_update") return null;
  const inline = update.entries;
  if (Array.isArray(inline)) return inline as AcpPlanEntry[];
  const nested = isRecord(update.plan) ? update.plan.entries : undefined;
  return Array.isArray(nested) ? (nested as AcpPlanEntry[]) : [];
};

/** Result text for a finished tool call: its content blocks, else raw output. */
export function toolResultText(update: AcpToolCallUpdate): string | undefined {
  const blocks = update.content;
  if (Array.isArray(blocks) && blocks.length > 0) {
    return blocks.map(blockText).filter(Boolean).join("\n");
  }
  if (update.rawOutput !== undefined) {
    return typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(update.rawOutput, null, 2);
  }
  return undefined;
}

/** The turn state an assistant message is in, for the pane's status line. */
export const statusForStop = (reason: AcpStopReason | string): ChatStatus =>
  reason === "refusal" ? "error" : "idle";

export interface AcpTurn {
  /** The assistant message being built, or null before the first chunk. */
  message: ChatMessage | null;
  status: ChatStatus;
}

export const emptyTurn = (): AcpTurn => ({
  message: null,
  status: "idle",
});

const newAssistant = (id: string): ChatMessage => ({
  id,
  role: "assistant",
  text: "",
  thinking: "",
  tools: [],
  streaming: true,
  startedAt: Date.now(),
});

/**
 * Fold one `session/update` into the turn. Returns a new turn — the caller
 * decides what to do with it, so this stays testable without React.
 */
export function applyUpdate(turn: AcpTurn, update: AcpUpdate, id: string): AcpTurn {
  if (!isRecord(update)) return turn;
  const kind = update.sessionUpdate;
  const message = turn.message ?? newAssistant(id);

  const entries = planEntriesOf(update);
  if (entries) {
    // A plan update is an upsert: the agent revises one plan as it works, so a
    // later version replaces the card rather than stacking another beside it.
    const tool = planTool(entries, planKeyOf(update));
    const tools = message.tools.some((t) => t.id === tool.id)
      ? message.tools.map((t) => (t.id === tool.id ? tool : t))
      : [...message.tools, tool];
    return { ...turn, message: { ...message, tools }, status: "tool" };
  }

  switch (kind) {
    case "agent_message_chunk": {
      const text = blockText((update as { content?: AcpContentBlock }).content);
      if (!text) return turn;
      return {
        ...turn,
        message: { ...message, text: message.text + text },
        status: "streaming",
      };
    }
    case "agent_thought_chunk": {
      const text = blockText((update as { content?: AcpContentBlock }).content);
      if (!text) return turn;
      return {
        ...turn,
        message: { ...message, thinking: message.thinking + text },
        status: "thinking",
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const call = update as AcpToolCallUpdate;
      if (!call.toolCallId) return turn;
      const existing = message.tools.find((t) => t.id === call.toolCallId);
      const result = toolResultText(call);
      const merged: ToolCall = {
        id: call.toolCallId,
        // A tool call's title is what the agent chose to call it; the kind is
        // the fallback, because an untitled card reading "other" says nothing.
        name: call.title ?? existing?.name ?? call.kind ?? "tool",
        input: call.rawInput ?? existing?.input ?? {},
        partial: "",
        result: result ?? existing?.result,
        isError: call.status === "failed" ? true : existing?.isError,
      };
      const tools = existing
        ? message.tools.map((t) => (t.id === merged.id ? merged : t))
        : [...message.tools, merged];
      return { ...turn, message: { ...message, tools }, status: "tool" };
    }
    // The pane renders the user's own turn; echoing the agent's copy of it
    // would double every prompt.
    case "user_message_chunk":
      return turn;
    default:
      return turn;
  }
}

/** Close the turn: nothing is streaming once the prompt has replied. */
export function endTurn(turn: AcpTurn, reason: AcpStopReason | string): AcpTurn {
  return {
    ...turn,
    message: turn.message
      ? { ...turn.message, streaming: false, endedAt: Date.now() }
      : null,
    status: statusForStop(reason),
  };
}

export interface AcpPermission {
  requestId: number;
  title: string;
  description?: string;
  toolCallId?: string;
  options: { optionId: string; name: string; kind?: string }[];
}

/** Read a permission request from either revision's shape. */
export function readPermission(
  requestId: number,
  params: unknown
): AcpPermission | null {
  if (!isRecord(params)) return null;
  const req = params as unknown as AcpPermissionRequest;
  const toolCall = req.toolCall ?? req.subject?.toolCall;
  const options = Array.isArray(req.options) ? req.options : [];
  if (options.length === 0) return null;
  return {
    requestId,
    title: req.title ?? toolCall?.title ?? "Allow this action?",
    description: req.description,
    toolCallId: toolCall?.toolCallId,
    options: options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    })),
  };
}

/** The reply body for a chosen option, or for backing out. */
export const permissionOutcome = (optionId: string | null) =>
  optionId === null
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId } };
