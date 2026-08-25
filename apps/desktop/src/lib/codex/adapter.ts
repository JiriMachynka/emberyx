/**
 * Normalises `codex app-server` notifications into the message model the chat
 * pane already renders. Pure and synchronous: the hook owns the process, the
 * channel and React state; everything about *what a frame means* lives here.
 *
 * Codex reports an assistant turn as a stream of independent items (a message,
 * a reasoning block, a command, a patch), while the pane expects one assistant
 * message per turn carrying text, thinking and tool calls. Item text is kept
 * per item id so `item/completed` can replace an item's streamed deltas with
 * the authoritative text without disturbing its neighbours.
 */

import type {
  ChatMessage,
  ChatQuota,
  ChatStatus,
  ChatUsage,
  PendingAsk,
  PendingPermission,
  PermissionDecision,
  ToolCall,
} from "@/hooks/useAgentChat";
import { codexCost } from "@/lib/pricing";
import { describeTool } from "@/lib/toolDisplay";
import type { SubagentActivity } from "@/lib/agentStore";
import {
  decodeDelta,
  decodeError,
  decodeHookRun,
  decodeItem,
  decodePlan,
  decodeQuestions,
  decodeRateLimits,
  decodeTokenUsage,
  decodeTurn,
  frameThreadId,
  isRecord,
} from "./decode";
import type {
  CodexApprovalDecision,
  CodexItem,
  ToolUserInputQuestion,
} from "./protocol";
import { statusForEvent } from "@/lib/status";
import type { SessionStatus } from "@/types";

/** One file the turn touched, in the shape the changes feed diffs. */
export interface CodexFileChange {
  path: string;
  tool: string;
  oldText: string;
  newText: string;
}

/** Text sinks for one turn, ordered by first appearance. */
interface Sink {
  id: string;
  text: string;
}

interface TurnDraft {
  turnId: string;
  messageId: string;
  texts: Sink[];
  thinking: Sink[];
}

export interface CodexChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  usage: ChatUsage;
  /** Turn in flight — required by `turn/interrupt` and `turn/steer`. */
  turnId: string | null;
  /** Why the last turn failed; rendered under the composer. */
  errorMessage: string | null;
  draft: TurnDraft | null;
  /** Subagent thread id -> the tool call that spawned it. Those threads stream
   *  over the same connection, so this is what keeps their turns out of the
   *  transcript and in the run they belong to. */
  agentThreads: Record<string, string>;
}

/** One thing to do to a subagent run. The adapter is pure, so the hook applies
 *  these to the store the way it applies `changes` to the changes feed. */
export type CodexSubagentEvent =
  | { type: "start"; id: string; description: string; prompt: string }
  | { type: "activity"; id: string; activity: SubagentActivity }
  | { type: "end"; id: string; isError: boolean };

export interface CodexApply {
  state: CodexChatState;
  /** File edits to push into the changes feed. Empty for most frames. */
  changes: CodexFileChange[];
  /** Subagent bookkeeping. Empty for most frames. */
  subagents: CodexSubagentEvent[];
  /** Session status a hook run implies, when it implies one. */
  sessionStatus?: SessionStatus;
}

export const initialCodexState = (): CodexChatState => ({
  messages: [],
  status: "idle",
  usage: {},
  turnId: null,
  errorMessage: null,
  draft: null,
  agentThreads: {},
});

const joinSinks = (sinks: Sink[]): string =>
  sinks
    .map((s) => s.text)
    .filter(Boolean)
    .join("\n\n");

/** Replace the draft's assistant message with `patch` applied. */
const patchDraftMessage = (
  state: CodexChatState,
  patch: (m: ChatMessage) => ChatMessage
): CodexChatState => {
  const draft = state.draft;
  if (!draft) return state;
  const i = state.messages.findIndex((m) => m.id === draft.messageId);
  if (i === -1) return state;
  const messages = state.messages.slice();
  messages[i] = patch(messages[i]);
  return { ...state, messages };
};

/** Append or overwrite a text sink, then republish the joined result. */
const writeSink = (
  state: CodexChatState,
  field: "texts" | "thinking",
  itemId: string,
  write: (previous: string) => string
): CodexChatState => {
  const draft = state.draft;
  if (!draft) return state;
  const sinks = draft[field];
  const i = sinks.findIndex((s) => s.id === itemId);
  const next =
    i === -1
      ? [...sinks, { id: itemId, text: write("") }]
      : sinks.map((s, n) => (n === i ? { id: s.id, text: write(s.text) } : s));
  const nextDraft = { ...draft, [field]: next };
  const joined = joinSinks(next);
  return patchDraftMessage(
    { ...state, draft: nextDraft },
    (m) => (field === "texts" ? { ...m, text: joined } : { ...m, thinking: joined })
  );
};

/** Insert or update a tool call on the draft message, keyed by item id. */
const upsertTool = (
  state: CodexChatState,
  id: string,
  patch: (previous: ToolCall | undefined) => ToolCall
): CodexChatState =>
  patchDraftMessage(state, (m) => {
    const i = m.tools.findIndex((t) => t.id === id);
    const tools = m.tools.slice();
    if (i === -1) tools.push(patch(undefined));
    else tools[i] = patch(tools[i]);
    return { ...m, tools };
  });

/** Codex tool items rendered under the tool names the pane already draws. */
const toolShapeFor = (
  item: CodexItem
): { name: string; input: unknown } | null => {
  switch (item.type) {
    case "commandExecution":
      return { name: "Bash", input: { command: item.command } };
    case "fileChange":
      return { name: "ApplyPatch", input: { changes: item.changes } };
    case "mcpToolCall":
      return {
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments ?? {},
      };
    case "dynamicToolCall":
      return { name: item.tool, input: item.arguments ?? {} };
    case "plan":
      return { name: "Plan", input: { plan: item.text } };
    case "unknown":
      return { name: item.kind, input: item.raw };
    default:
      return null;
  }
};

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

const resultFor = (
  item: CodexItem
): { result: string; isError: boolean } | null => {
  switch (item.type) {
    case "commandExecution":
      return {
        result: item.aggregatedOutput ?? "",
        isError: item.status === "failed" || item.status === "declined",
      };
    case "fileChange":
      return {
        result: item.changes.map((c) => c.path).join("\n"),
        isError: item.status === "failed" || item.status === "declined",
      };
    case "mcpToolCall":
      return {
        result: asText(item.error ?? item.result),
        isError: item.status === "failed",
      };
    case "dynamicToolCall":
      return { result: asText(item.contentItems), isError: item.status === "failed" };
    default:
      return null;
  }
};

/** Reasoning items carry a summary and full content; prefer whichever the
 *  model actually produced. */
const reasoningText = (item: Extract<CodexItem, { type: "reasoning" }>): string =>
  (item.content.length ? item.content : item.summary).join("\n\n");

/**
 * Split a unified diff into the text before and after the change. Only the
 * hunks are recoverable — that is what the changes viewer shows anyway.
 */
export function splitUnifiedDiff(diff: string): { oldText: string; newText: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split("\n")) {
    if (
      line.startsWith("@@") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  return { oldText: before.join("\n"), newText: after.join("\n") };
}

const CHANGE_TOOL: Record<string, string> = {
  add: "Write",
  delete: "Delete",
  update: "Edit",
};

const changesFrom = (item: CodexItem): CodexFileChange[] => {
  if (item.type !== "fileChange") return [];
  return item.changes.map((c) => ({
    path: c.path,
    tool: CHANGE_TOOL[c.kind.type] ?? "Edit",
    ...splitUnifiedDiff(c.diff),
  }));
};

/** A turn's todo list, kept as a synthetic TodoWrite call so it renders with
 *  the same checklist the Claude path draws. */
const PLAN_TOOL_SUFFIX = "#plan";

/** First line of a subagent's brief — all the run header has room for. */
const AGENT_DESCRIPTION_CHARS = 80;

const briefOf = (prompt: string | null): string =>
  (prompt ?? "").trim().split("\n")[0].slice(0, AGENT_DESCRIPTION_CHARS) || "Agent";

/** Statuses that mean the agent has stopped, and whether it stopped badly. */
const ENDED_AGENT_STATUSES = new Set([
  "completed",
  "errored",
  "shutdown",
  "interrupted",
  "notFound",
]);

/**
 * A frame that arrived on a subagent's thread. Its work is the run's activity
 * log, never the parent transcript, so nothing here touches `messages`.
 */
function subagentFrame(
  state: CodexChatState,
  runId: string,
  method: string,
  params: unknown
): CodexApply {
  const empty: CodexApply = { state, changes: [], subagents: [] };
  if (method !== "item/completed") return empty;
  const item = decodeItem(params);
  if (!item) return empty;

  if (item.type === "agentMessage") {
    const text = item.text.trim();
    if (!text) return empty;
    return {
      ...empty,
      subagents: [
        { type: "activity", id: runId, activity: { kind: "text", name: "", detail: text } },
      ],
    };
  }

  const shape = toolShapeFor(item);
  if (!shape) return empty;
  const d = describeTool(shape.name, shape.input);
  return {
    ...empty,
    subagents: [
      {
        type: "activity",
        id: runId,
        activity: { kind: "tool", name: d.label, detail: d.title ?? "", icon: d.icon },
      },
    ],
  };
}

/**
 * A collab tool call — Codex's subagent surface. `spawnAgent` opens a run and
 * renders where it was dispatched; the follow-up calls (`wait`, `sendInput`)
 * only carry the agents' state, so they settle runs rather than drawing cards.
 */
function collabFrame(
  state: CodexChatState,
  item: Extract<CodexItem, { type: "collabAgentToolCall" }>,
  done: boolean
): CodexApply {
  const events: CodexSubagentEvent[] = [];
  let next = state;

  if (item.tool === "spawnAgent") {
    if (!done) {
      events.push({
        type: "start",
        id: item.id,
        description: briefOf(item.prompt),
        prompt: item.prompt ?? "",
      });
    }
    // The spawned thread is only named once the call completes.
    for (const threadId of item.receiverThreadIds) {
      next = { ...next, agentThreads: { ...next.agentThreads, [threadId]: item.id } };
    }
    // `Agent` is the name ChatPane renders a subagent under.
    next = upsertTool(next, item.id, (prev) => ({
      id: item.id,
      name: "Agent",
      input: { description: briefOf(item.prompt), prompt: item.prompt ?? "" },
      partial: prev?.partial ?? "",
      result: prev?.result,
      isError: prev?.isError,
    }));
  }

  for (const [threadId, agent] of Object.entries(item.agentsStates)) {
    const runId = next.agentThreads[threadId];
    if (!runId || !ENDED_AGENT_STATUSES.has(agent.status)) continue;
    if (agent.message) {
      events.push({
        type: "activity",
        id: runId,
        activity: { kind: "text", name: "", detail: agent.message },
      });
    }
    events.push({ type: "end", id: runId, isError: agent.status !== "completed" });
  }

  return { state: next, changes: [], subagents: events };
}

const startTurn = (state: CodexChatState, turnId: string): CodexChatState => {
  const message: ChatMessage = {
    id: turnId,
    role: "assistant",
    text: "",
    thinking: "",
    tools: [],
    streaming: true,
    startedAt: Date.now(),
  };
  return {
    ...state,
    messages: [...state.messages, message],
    draft: { turnId, messageId: turnId, texts: [], thinking: [] },
    turnId,
    errorMessage: null,
    status: "thinking",
  };
};

const endTurn = (state: CodexChatState, status: ChatStatus): CodexChatState => {
  const ended = patchDraftMessage(state, (m) => ({
    ...m,
    streaming: false,
    endedAt: Date.now(),
  }));
  return { ...ended, draft: null, turnId: null, status };
};

/**
 * Fold one server notification into the chat state. Unknown methods are
 * ignored — the protocol is additive and most frames are telemetry.
 */
export function applyCodexNotification(
  state: CodexChatState,
  method: string,
  params: unknown
): CodexApply {
  const none = (next: CodexChatState): CodexApply => ({
    state: next,
    changes: [],
    subagents: [],
  });

  const onAgentThread = frameThreadId(params);
  if (onAgentThread && state.agentThreads[onAgentThread]) {
    return subagentFrame(state, state.agentThreads[onAgentThread], method, params);
  }

  switch (method) {
    case "turn/started": {
      const turn = decodeTurn(params);
      if (!turn) return none(state);
      // A resumed thread can replay its active turn; don't open a second draft.
      if (state.draft?.turnId === turn.id) return none(state);
      return none(startTurn(state, turn.id));
    }

    case "turn/completed": {
      const turn = decodeTurn(params);
      if (!turn) return none(state);
      return none(endTurn(state, turn.status === "failed" ? "error" : "idle"));
    }

    case "error": {
      const err = decodeError(params);
      if (!err) return none(state);
      // Backpressure is retried by the server; say so instead of failing.
      if (err.willRetry) return none({ ...state, status: "retrying" });
      return none({
        ...endTurn(state, "error"),
        errorMessage: err.message,
      });
    }

    case "item/started":
    case "item/completed": {
      const item = decodeItem(params);
      if (!item || item.type === "userMessage") return none(state);
      const done = method === "item/completed";

      if (item.type === "agentMessage") {
        const next = writeSink(state, "texts", item.id, (prev) =>
          done ? item.text || prev : prev
        );
        return none({ ...next, status: done ? next.status : "streaming" });
      }

      if (item.type === "reasoning") {
        const text = reasoningText(item);
        return none(
          writeSink(state, "thinking", item.id, (prev) => (done && text ? text : prev))
        );
      }

      if (item.type === "collabAgentToolCall") return collabFrame(state, item, done);

      const shape = toolShapeFor(item);
      if (!shape) return none(state);
      const outcome = done ? resultFor(item) : null;
      const next = upsertTool(state, item.id, (prev) => ({
        id: item.id,
        name: shape.name,
        input: shape.input,
        partial: prev?.partial ?? "",
        // Live output already streamed in; keep it unless the item supersedes it.
        result: outcome ? outcome.result || prev?.result : prev?.result,
        isError: outcome ? outcome.isError : prev?.isError,
      }));
      return {
        state: { ...next, status: done ? next.status : "tool" },
        changes: done ? changesFrom(item) : [],
        subagents: [],
      };
    }

    case "item/agentMessage/delta": {
      const d = decodeDelta(params);
      if (!d) return none(state);
      const next = writeSink(state, "texts", d.itemId, (prev) => prev + d.delta);
      return none({ ...next, status: "streaming" });
    }

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      const d = decodeDelta(params);
      if (!d) return none(state);
      return none(writeSink(state, "thinking", d.itemId, (prev) => prev + d.delta));
    }

    case "item/commandExecution/outputDelta": {
      const d = decodeDelta(params);
      if (!d) return none(state);
      return none(
        upsertTool(state, d.itemId, (prev) => ({
          id: d.itemId,
          name: prev?.name ?? "Bash",
          input: prev?.input ?? {},
          partial: prev?.partial ?? "",
          result: (prev?.result ?? "") + d.delta,
          isError: prev?.isError,
        }))
      );
    }

    case "item/plan/delta": {
      const d = decodeDelta(params);
      if (!d) return none(state);
      return none(
        upsertTool(state, d.itemId, (prev) => {
          const plan =
            isRecord(prev?.input) && typeof prev.input.plan === "string"
              ? prev.input.plan
              : "";
          return {
            id: d.itemId,
            name: "Plan",
            input: { plan: plan + d.delta },
            partial: prev?.partial ?? "",
            result: prev?.result,
            isError: prev?.isError,
          };
        })
      );
    }

    case "turn/plan/updated": {
      const steps = decodePlan(params);
      if (!steps || !state.draft) return none(state);
      const id = state.draft.turnId + PLAN_TOOL_SUFFIX;
      const todos = steps.map((s) => ({
        content: s.step,
        status: s.status === "inProgress" ? "in_progress" : s.status,
      }));
      return none(
        upsertTool(state, id, () => ({
          id,
          name: "TodoWrite",
          input: { todos },
          partial: "",
        }))
      );
    }

    case "thread/tokenUsage/updated": {
      const u = decodeTokenUsage(params);
      if (!u) return none(state);
      // Codex reports no cost, so it is computed from the rate card here and
      // flagged as an estimate. An unpriced model leaves it undefined.
      const costUsd = codexCost(state.usage.model ?? "", u.total);
      const usage: ChatUsage = {
        ...state.usage,
        inputTokens: u.total.inputTokens,
        outputTokens: u.total.outputTokens,
        // The last request's whole footprint is how full the window is now.
        contextTokens: u.last.totalTokens,
        contextWindow: u.modelContextWindow ?? state.usage.contextWindow,
        costUsd,
        costEstimated: costUsd !== undefined,
      };
      return none({ ...state, usage });
    }

    // Codex runs hooks in-process and reports them here, so the status feed
    // needs no listener of its own — unlike Claude, which drives it over HTTP.
    case "hook/started":
    case "hook/completed": {
      const run = decodeHookRun(params);
      if (!run) return none(state);
      const status = statusForEvent(run.eventName, undefined, "codex");
      return status ? { ...none(state), sessionStatus: status } : none(state);
    }

    case "account/rateLimits/updated": {
      const limits = decodeRateLimits(params);
      if (!limits) return none(state);
      const quota: ChatQuota = {
        primary: limits.primary,
        secondary: limits.secondary,
        planType: limits.planType,
      };
      return none({ ...state, usage: { ...state.usage, quota } });
    }

    default:
      return none(state);
  }
}

// ---------------------------------------------------------------------------
// Server -> client requests
// ---------------------------------------------------------------------------

export interface CodexServerRequest {
  id: number;
  method: string;
  params: unknown;
}

export const APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];

export const ASK_METHODS = [
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
];

const approvalToolName = (method: string): string => {
  if (method === "item/commandExecution/requestApproval") return "Bash";
  if (method === "item/fileChange/requestApproval") return "ApplyPatch";
  return "Permissions";
};

/**
 * Turn an approval request into the pane's pending-permission shape. The
 * request itself is thin (ids plus a reason), so the already-rendered tool
 * call for the same item supplies what the user actually needs to read.
 */
export function permissionFromRequest(
  state: CodexChatState,
  req: CodexServerRequest
): PendingPermission | null {
  if (!APPROVAL_METHODS.includes(req.method)) return null;
  const p = isRecord(req.params) ? req.params : {};
  const itemId = typeof p.itemId === "string" ? p.itemId : "";
  const known = state.messages
    .flatMap((m) => m.tools)
    .find((t) => t.id === itemId);
  const base = isRecord(known?.input) ? known.input : {};
  const extra: Record<string, unknown> = {};
  if (typeof p.reason === "string") extra.reason = p.reason;
  if (typeof p.command === "string") extra.command = p.command;
  if (typeof p.cwd === "string") extra.cwd = p.cwd;
  if (p.permissions !== undefined) extra.permissions = p.permissions;
  return {
    requestId: String(req.id),
    toolName: known?.name ?? approvalToolName(req.method),
    input: { ...base, ...extra },
    // The profile the server asked for, echoed back when the user allows.
    suggestions: p.permissions === undefined ? [] : [p.permissions],
    toolUseId: itemId,
  };
}

const DECISIONS: Record<PermissionDecision, CodexApprovalDecision> = {
  allow_once: "accept",
  allow_always: "acceptForSession",
  deny: "decline",
};

/**
 * The JSON-RPC result for a decided approval. `item/permissions` has no
 * decline arm — the response is the profile that was granted, so declining
 * grants nothing.
 */
export function approvalResult(
  method: string,
  decision: PermissionDecision,
  requested: unknown
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return decision === "deny"
      ? { permissions: {}, scope: "turn" }
      : {
          permissions: isRecord(requested) ? requested : {},
          scope: decision === "allow_always" ? "session" : "turn",
        };
  }
  return { decision: DECISIONS[decision] };
}

/** The question set a pending ask was built from, kept so the answer can be
 *  routed back to the right question ids. */
export interface CodexAsk {
  requestId: number;
  method: string;
  questions: ToolUserInputQuestion[];
}

const ELICITATION_OPTIONS = [
  { label: "Accept", description: "" },
  { label: "Decline", description: "" },
];

/** Both interactive requests render through the existing option picker. */
export function askFromRequest(
  req: CodexServerRequest
): { pending: PendingAsk; ask: CodexAsk } | null {
  const p = isRecord(req.params) ? req.params : {};

  if (req.method === "item/tool/requestUserInput") {
    const questions = decodeQuestions(p);
    if (!questions.length) return null;
    return {
      pending: {
        id: String(req.id),
        questions: questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options ?? [],
          multiSelect: false,
        })),
      },
      ask: { requestId: req.id, method: req.method, questions },
    };
  }

  if (req.method === "mcpServer/elicitation/request") {
    const server = typeof p.serverName === "string" ? p.serverName : "MCP server";
    const message = typeof p.message === "string" ? p.message : "";
    const question: ToolUserInputQuestion = {
      id: "elicitation",
      header: server,
      question: message,
      options: ELICITATION_OPTIONS,
    };
    return {
      pending: {
        id: String(req.id),
        questions: [
          { question: message, header: server, options: ELICITATION_OPTIONS, multiSelect: false },
        ],
      },
      ask: { requestId: req.id, method: req.method, questions: [question] },
    };
  }

  return null;
}

/**
 * Map the picker's joined answer back onto per-question answers. The picker
 * emits one line per question in order, prefixed with the header when there is
 * more than one, and joins a multi-select with ", ".
 */
export function askResult(ask: CodexAsk, answer: string): Record<string, unknown> {
  if (ask.method === "mcpServer/elicitation/request") {
    const action = answer.trim().toLowerCase().startsWith("accept")
      ? "accept"
      : "decline";
    return { action, content: null, _meta: null };
  }
  const lines = answer.split("\n");
  const answers: Record<string, { answers: string[] }> = {};
  ask.questions.forEach((q, i) => {
    const line = lines[i] ?? "";
    const prefix = `${q.header || q.question}: `;
    const body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    answers[q.id] = { answers: body.split(", ").filter(Boolean) };
  });
  return { answers };
}
