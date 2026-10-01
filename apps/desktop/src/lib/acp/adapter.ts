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
import { upsertActivities } from "@/lib/activities";
import type { ActivityItem, Json, JsonObject } from "@/types";
import { acpActivity } from "./activities";
import type {
  AcpConfigOption,
  AcpContentBlock,
  AcpPlanEntry,
  AcpStopReason,
  AcpToolCallUpdate,
  AcpUpdate,
} from "./protocol";
import type { AccessLevel } from "@/lib/settings";

const isRecord = (v: Json | undefined): v is JsonObject =>
  typeof v === "object" && v !== null;

const asString = (v: Json | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/** A tool call as either revision states it: `{ toolCallId, title, kind }`. */
const readToolCall = (
  v: Json | undefined
): { toolCallId?: string; title?: string; kind?: string } | null => {
  if (!isRecord(v)) return null;
  return {
    toolCallId: asString(v.toolCallId),
    title: asString(v.title),
    kind: asString(v.kind),
  };
};

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
export function planKeyOf(update: AcpUpdate): string {
  const plan = "plan" in update ? update.plan : undefined;
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
export const planEntriesOf = (update: AcpUpdate): AcpPlanEntry[] | null => {
  if (update.sessionUpdate !== "plan" && update.sessionUpdate !== "plan_update") {
    return null;
  }
  // Frames are not trusted: a non-array is no plan, not a crash.
  const inline = "entries" in update ? update.entries : undefined;
  if (Array.isArray(inline)) return inline;
  const nested = "plan" in update ? update.plan?.entries : undefined;
  return Array.isArray(nested) ? nested : [];
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

/**
 * Grok 1.0.24 announces turn end as vendor notifications *before* it replies
 * to `session/prompt`. Waiting only on that reply left a finished turn on
 * "Responding…". `stopReason` / `stop_reason` is `end_turn` when the agent
 * says; anything else is still a completed turn.
 */
export const grokTurnStop = (method: string, params: Json): string | null => {
  if (!isRecord(params)) return null;
  if (method === "_x.ai/session/prompt_complete") {
    return typeof params.stopReason === "string" ? params.stopReason : "end_turn";
  }
  if (method === "_x.ai/session_notification") {
    const update = isRecord(params.update) ? params.update : null;
    if (update?.sessionUpdate === "turn_completed") {
      return typeof update.stop_reason === "string" ? update.stop_reason : "end_turn";
    }
  }
  return null;
};

/** The `session/update` payload, including Grok's vendor-wrapped copy. */
export const sessionUpdateOf = (method: string, params: Json): Json => {
  if (!isRecord(params)) return null;
  if (method === "session/update") return params.update ?? null;
  if (method === "_x.ai/session_notification" && isRecord(params.update)) {
    return params.update;
  }
  return null;
};

/** One select entry; ACP also allows grouped entries, which are flattened. */
const selectValues = (v: Json): { value: string; name?: string }[] => {
  if (!isRecord(v) || Array.isArray(v)) return [];
  if (Array.isArray(v.options)) return v.options.flatMap(selectValues);
  return typeof v.value === "string" ? [{ value: v.value, name: asString(v.name) }] : [];
};

const decodeConfigOption = (v: Json): AcpConfigOption[] => {
  if (!isRecord(v) || Array.isArray(v) || typeof v.id !== "string") return [];
  return [
    {
      id: v.id,
      name: asString(v.name),
      category: asString(v.category),
      type: asString(v.type),
      currentValue: asString(v.currentValue),
      options: Array.isArray(v.options) ? v.options.flatMap(selectValues) : undefined,
    },
  ];
};

/**
 * The config options a `session/set_config_option` reply or a
 * `config_option_update` carries — both are `{ configOptions: [...] }`, and the
 * list is always the whole set, so it replaces rather than merges. Null when the
 * frame names none, which is not the same as an empty set.
 */
export const configOptionsOf = (value: Json): AcpConfigOption[] | null => {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.configOptions)
      ? value.configOptions
      : null;
  return list ? list.flatMap(decodeConfigOption) : null;
};

/** Live context fill from ACP `usage_update`. `size` is the window; `used` is
 *  how full it is. Cost is taken only in USD — any other currency would need
 *  a conversion we do not have. */
export interface AcpUsage {
  contextTokens: number;
  contextWindow: number;
  costUsd?: number;
}

export const readUsageUpdate = (update: Json): AcpUsage | null => {
  if (!isRecord(update) || update.sessionUpdate !== "usage_update") return null;
  const used = update.used;
  const size = update.size;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  const cost = isRecord(update.cost) ? update.cost : null;
  const amount = cost && typeof cost.amount === "number" && Number.isFinite(cost.amount)
    ? cost.amount
    : undefined;
  const currency = cost && typeof cost.currency === "string" ? cost.currency : undefined;
  return {
    contextTokens: used,
    contextWindow: size,
    ...(amount !== undefined && currency === "USD" ? { costUsd: amount } : {}),
  };
};

/** Fold a row into a message's ordered stream. */
const withActivity = (message: ChatMessage, item: ActivityItem): ChatMessage => ({
  ...message,
  activities: upsertActivities(message.activities, [item]),
});

/** The trailing reasoning row, when the last thing that happened was thinking.
 *  A run of consecutive thought chunks is one row; anything else ends it. */
const openReasoning = (message: ChatMessage): ActivityItem | null => {
  const rows = message.activities;
  if (!rows?.length) return null;
  const last = rows[rows.length - 1];
  return last.kind === "reasoning" && !last.complete ? last : null;
};

/** Settle a reasoning run that some other work has now interrupted. */
const closeReasoning = (message: ChatMessage): ChatMessage => {
  const open = openReasoning(message);
  return open ? withActivity(message, { ...open, complete: true }) : message;
};

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
  activities: [],
  streaming: true,
  startedAt: Date.now(),
});

/**
 * Fold one `session/update` into the turn. Returns a new turn — the caller
 * decides what to do with it, so this stays testable without React.
 */
export function applyUpdate(
  turn: AcpTurn,
  update: AcpUpdate,
  id: string,
  /** Tool calls whose permission request the client answered on the user's
   *  behalf. Passed in rather than remembered here so this stays pure — the
   *  hook owns the set, since it is the side that answers. */
  autoApproved?: ReadonlySet<string>
): AcpTurn {
  if (typeof update !== "object" || update === null) return turn;
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
    const settled = closeReasoning({ ...message, tools });
    return {
      ...turn,
      message: withActivity(settled, {
        id: tool.id,
        kind: "plan",
        title: "TodoWrite",
        arguments: JSON.stringify(tool.input, null, 2),
        failed: false,
        complete: true,
      }),
      status: "tool",
    };
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
      // ACP gives thought no id, so the row is keyed by where the run started.
      const open = openReasoning(message);
      const row: ActivityItem = open
        ? { ...open, output: (open.output ?? "") + text }
        : {
            id: `${message.id}:r${message.activities?.length ?? 0}`,
            kind: "reasoning",
            title: "Thinking",
            output: text,
            failed: false,
            complete: false,
          };
      return {
        ...turn,
        message: withActivity(
          { ...message, thinking: message.thinking + text },
          row
        ),
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
      const previous = message.activities?.find((a) => a.id === call.toolCallId);
      const settled = closeReasoning({ ...message, tools });
      return {
        ...turn,
        message: withActivity(
          settled,
          acpActivity(call, result, previous, autoApproved?.has(call.toolCallId))
        ),
        status: "tool",
      };
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
      ? {
          // Nothing follows to end the last reasoning run, so the turn does.
          ...closeReasoning(turn.message),
          streaming: false,
          endedAt: Date.now(),
        }
      : null,
    status: statusForStop(reason),
  };
}

export interface AcpPermission {
  requestId: number;
  title: string;
  description?: string;
  toolCallId?: string;
  /** What the blocked tool call does (`edit`, `execute`, …), when the agent
   *  says. Read by `autoPermission` — a request with no kind is never
   *  auto-answered below full access. */
  toolKind?: string;
  options: { optionId: string; name: string; kind?: string }[];
}

/** Read a permission request from either revision's shape. */
export function readPermission(
  requestId: number,
  params: Json
): AcpPermission | null {
  if (!isRecord(params)) return null;
  // v1 states the tool call at the top level; the v2 draft wraps it in a
  // tagged `subject`. Read both without trusting the frame's shape.
  const subject = isRecord(params.subject) ? params.subject : null;
  const toolCall =
    readToolCall(params.toolCall) ?? readToolCall(subject?.toolCall);
  const rawOptions = Array.isArray(params.options) ? params.options : [];
  const options = rawOptions.flatMap(
    (o): { optionId: string; name: string; kind?: string }[] => {
      if (!isRecord(o)) return [];
      const optionId = asString(o.optionId);
      const name = asString(o.name);
      // An option the user cannot identify is not one they can answer.
      if (optionId === undefined || name === undefined) return [];
      return [{ optionId, name, kind: asString(o.kind) }];
    }
  );
  if (options.length === 0) return null;
  return {
    requestId,
    title: asString(params.title) ?? toolCall?.title ?? "Allow this action?",
    description: asString(params.description),
    toolCallId: toolCall?.toolCallId,
    toolKind: toolCall?.kind,
    options,
  };
}

/** Tool kinds "Accept edits" answers on its own. Reading and writing files is
 *  what that level promises; running a command is not, so `execute` and
 *  `delete` still ask. */
const AUTO_EDIT_KINDS = new Set(["read", "edit"]);

/** Emberyx's own MCP tools: read-only, local-only, already pre-allowed for
 *  Claude via `--allowedTools`. ACP has no spawn-time allow-list, so the
 *  client answers these without a prompt at every access level. */
const EMBERXY_TOOLS =
  /(?:ask_user|preview_screenshot|preview_console|preview_snapshot)/;

const isEmberyxTool = (permission: AcpPermission): boolean =>
  EMBERXY_TOOLS.test(permission.title) ||
  EMBERXY_TOOLS.test(permission.description ?? "");

/**
 * The option that answers a permission request without prompting, or `null` to
 * ask the user. ACP has no spawn-time bypass the way Claude's
 * `--dangerously-skip-permissions` or Codex's `approvalPolicy: "never"` do, so
 * the access level is honoured here — by the client answering for the user.
 *
 * `allow_always` is preferred so the agent stops asking; an agent that offers
 * only `allow_once` is answered with that every time rather than falling back
 * to a prompt the level said not to show.
 */
export const autoPermission = (
  permission: AcpPermission,
  access: AccessLevel
): string | null => {
  if (isEmberyxTool(permission)) {
    const pick =
      permission.options.find((o) => o.kind === "allow_always") ??
      permission.options.find((o) => o.kind === "allow_once");
    return pick?.optionId ?? null;
  }
  if (access === "ask") return null;
  if (access === "acceptEdits" && !AUTO_EDIT_KINDS.has(permission.toolKind ?? ""))
    return null;
  const pick =
    permission.options.find((o) => o.kind === "allow_always") ??
    permission.options.find((o) => o.kind === "allow_once");
  return pick?.optionId ?? null;
};

/** The reply body for a chosen option, or for backing out. */
export const permissionOutcome = (optionId: string | null): JsonObject =>
  optionId === null
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId } };
