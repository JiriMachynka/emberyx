/**
 * Runtime narrowing for app-server payloads. Everything crossing the Tauri
 * channel is `unknown`; these decoders validate a frame's fields and hand back
 * the vendored shape, or null when it doesn't match. A malformed frame is
 * dropped rather than crashing the transcript.
 */

import type {
  CodexHookRun,
  CodexItem,
  CodexModel,
  CodexSkill,
  CodexThread,
  CollabAgentState,
  CollabAgentStatus,
  CollabAgentTool,
  CollaborationMode,
  CommandExecutionStatus,
  FileUpdateChange,
  ItemDelta,
  PatchChangeKind,
  RateLimitSnapshot,
  RateLimitWindow,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  ToolCallStatus,
  ToolUserInputQuestion,
  TurnPlanStep,
  TurnPlanStepStatus,
  TurnStatus,
} from "./protocol";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const nullableNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] =>
  list(v).filter((x): x is string => typeof x === "string");

export const decodeDelta = (params: unknown): ItemDelta | null => {
  if (!isRecord(params)) return null;
  const turnId = str(params.turnId);
  const itemId = str(params.itemId);
  const delta = str(params.delta);
  if (turnId === undefined || itemId === undefined || delta === undefined) return null;
  return { turnId, itemId, delta };
};

export interface TurnFrame {
  id: string;
  status: TurnStatus;
}

// Literal comparison rather than a Set lookup: it narrows, so no cast is needed.
const turnStatus = (v: unknown): TurnStatus =>
  v === "completed" || v === "interrupted" || v === "failed" ? v : "inProgress";

const execStatus = (v: unknown): CommandExecutionStatus =>
  v === "completed" || v === "failed" || v === "declined" ? v : "inProgress";

const callStatus = (v: unknown): ToolCallStatus =>
  v === "completed" || v === "failed" ? v : "inProgress";

/** `turn/started` and `turn/completed` both carry `{ threadId, turn }`. */
export const decodeTurn = (params: unknown): TurnFrame | null => {
  if (!isRecord(params) || !isRecord(params.turn)) return null;
  const id = str(params.turn.id);
  if (id === undefined) return null;
  return { id, status: turnStatus(params.turn.status) };
};

const decodeChangeKind = (v: unknown): PatchChangeKind => {
  const type = isRecord(v) ? str(v.type) : undefined;
  if (type === "add" || type === "delete") return { type };
  return { type: "update", move_path: isRecord(v) ? (str(v.move_path) ?? null) : null };
};

const decodeChanges = (v: unknown): FileUpdateChange[] =>
  list(v).flatMap((c) => {
    if (!isRecord(c)) return [];
    const path = str(c.path);
    if (path === undefined) return [];
    return [{ path, kind: decodeChangeKind(c.kind), diff: str(c.diff) ?? "" }];
  });

const COLLAB_TOOLS: CollabAgentTool[] = [
  "spawnAgent",
  "sendInput",
  "resumeAgent",
  "wait",
  "closeAgent",
];

const collabTool = (v: unknown): CollabAgentTool =>
  COLLAB_TOOLS.find((t) => t === v) ?? "spawnAgent";

const COLLAB_STATUSES: CollabAgentStatus[] = [
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
];

const decodeAgentStates = (v: unknown): Record<string, CollabAgentState> => {
  if (!isRecord(v)) return {};
  const out: Record<string, CollabAgentState> = {};
  for (const [threadId, state] of Object.entries(v)) {
    if (!isRecord(state)) continue;
    out[threadId] = {
      status: COLLAB_STATUSES.find((s) => s === state.status) ?? "running",
      message: str(state.message) ?? null,
    };
  }
  return out;
};

/** The thread a notification belongs to. Subagent turns stream over the same
 *  connection, so this is the only thing separating them from the session's
 *  own transcript. */
export const frameThreadId = (params: unknown): string | undefined =>
  isRecord(params) ? str(params.threadId) : undefined;

/** `item/started` / `item/completed` payloads wrap the item in `{ item }`. */
export const decodeItem = (params: unknown): CodexItem | null => {
  if (!isRecord(params)) return null;
  const item = isRecord(params.item) ? params.item : params;
  const id = str(item.id);
  const kind = str(item.type);
  if (id === undefined || kind === undefined) return null;

  switch (kind) {
    case "agentMessage":
      return { type: "agentMessage", id, text: str(item.text) ?? "" };
    case "plan":
      return { type: "plan", id, text: str(item.text) ?? "" };
    case "reasoning":
      return {
        type: "reasoning",
        id,
        summary: strings(item.summary),
        content: strings(item.content),
      };
    case "commandExecution":
      return {
        type: "commandExecution",
        id,
        command: str(item.command) ?? "",
        cwd: str(item.cwd) ?? "",
        status: execStatus(item.status),
        aggregatedOutput: str(item.aggregatedOutput) ?? null,
        exitCode: nullableNum(item.exitCode),
      };
    case "fileChange":
      return {
        type: "fileChange",
        id,
        changes: decodeChanges(item.changes),
        status: execStatus(item.status),
      };
    case "mcpToolCall":
      return {
        type: "mcpToolCall",
        id,
        server: str(item.server) ?? "",
        tool: str(item.tool) ?? "",
        status: callStatus(item.status),
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      };
    case "dynamicToolCall":
      return {
        type: "dynamicToolCall",
        id,
        tool: str(item.tool) ?? "",
        arguments: item.arguments,
        status: callStatus(item.status),
        contentItems: item.contentItems,
      };
    case "userMessage":
      return { type: "userMessage", id };
    case "collabAgentToolCall":
      return {
        type: "collabAgentToolCall",
        id,
        tool: collabTool(item.tool),
        status: callStatus(item.status),
        receiverThreadIds: strings(item.receiverThreadIds),
        prompt: str(item.prompt) ?? null,
        agentsStates: decodeAgentStates(item.agentsStates),
      };
    default:
      return { type: "unknown", id, kind, raw: item };
  }
};

const decodeBreakdown = (v: unknown): TokenUsageBreakdown => {
  const o = isRecord(v) ? v : {};
  return {
    totalTokens: numOr(o.totalTokens, 0),
    inputTokens: numOr(o.inputTokens, 0),
    cachedInputTokens: numOr(o.cachedInputTokens, 0),
    outputTokens: numOr(o.outputTokens, 0),
  };
};

export const decodeTokenUsage = (params: unknown): ThreadTokenUsage | null => {
  if (!isRecord(params) || !isRecord(params.tokenUsage)) return null;
  const u = params.tokenUsage;
  return {
    total: decodeBreakdown(u.total),
    last: decodeBreakdown(u.last),
    modelContextWindow: nullableNum(u.modelContextWindow),
  };
};

const planStatus = (v: unknown): TurnPlanStepStatus =>
  v === "inProgress" || v === "completed" ? v : "pending";

export const decodePlan = (params: unknown): TurnPlanStep[] | null => {
  if (!isRecord(params)) return null;
  return list(params.plan).flatMap((s) => {
    if (!isRecord(s)) return [];
    const step = str(s.step);
    if (step === undefined) return [];
    return [{ step, status: planStatus(s.status) }];
  });
};

export interface ErrorFrame {
  message: string;
  code: string;
  willRetry: boolean;
}

/** `codexErrorInfo` is a string for unit variants and a single-key object for
 *  the data-carrying ones; both reduce to the variant name. */
const errorCode = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (isRecord(v)) return Object.keys(v)[0] ?? "other";
  return "other";
};

export const decodeError = (params: unknown): ErrorFrame | null => {
  if (!isRecord(params) || !isRecord(params.error)) return null;
  return {
    message: str(params.error.message) ?? "Codex reported an error",
    code: errorCode(params.error.codexErrorInfo),
    willRetry: params.willRetry === true,
  };
};

const decodeWindow = (v: unknown): RateLimitWindow | null => {
  if (!isRecord(v)) return null;
  return {
    usedPercent: numOr(v.usedPercent, 0),
    resetsAt: nullableNum(v.resetsAt),
    windowDurationMins: nullableNum(v.windowDurationMins),
  };
};

export const decodeRateLimits = (params: unknown): RateLimitSnapshot | null => {
  if (!isRecord(params) || !isRecord(params.rateLimits)) return null;
  const r = params.rateLimits;
  return {
    primary: decodeWindow(r.primary),
    secondary: decodeWindow(r.secondary),
    rateLimitReachedType: str(r.rateLimitReachedType) ?? null,
    planType: str(r.planType) ?? null,
  };
};

export const decodeThreads = (result: unknown): CodexThread[] => {
  if (!isRecord(result)) return [];
  return list(result.data).flatMap((t) => {
    if (!isRecord(t)) return [];
    const id = str(t.id);
    if (id === undefined) return [];
    return [
      {
        id,
        name: str(t.name) ?? null,
        preview: str(t.preview) ?? "",
        updatedAt: numOr(t.updatedAt, 0),
      },
    ];
  });
};

export const decodeModels = (result: unknown): CodexModel[] => {
  if (!isRecord(result)) return [];
  return list(result.data).flatMap((m) => {
    if (!isRecord(m)) return [];
    const id = str(m.id);
    if (id === undefined) return [];
    return [
      {
        id,
        displayName: str(m.displayName) ?? id,
        hidden: m.hidden === true,
        reasoningEfforts: list(m.supportedReasoningEfforts).flatMap((e) => {
          const effort = isRecord(e) ? str(e.reasoningEffort) : undefined;
          return effort === undefined ? [] : [effort];
        }),
        defaultReasoningEffort: str(m.defaultReasoningEffort) ?? "",
      },
    ];
  });
};

/** `skills/list` answers per cwd, each with its own skill array. */
export const decodeSkills = (result: unknown): CodexSkill[] => {
  if (!isRecord(result)) return [];
  return list(result.data).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return list(entry.skills).flatMap((s) => {
      if (!isRecord(s)) return [];
      const name = str(s.name);
      if (name === undefined || s.enabled === false) return [];
      return [
        {
          name,
          description: str(s.shortDescription) ?? str(s.description) ?? "",
          scope: str(s.scope) ?? "user",
        },
      ];
    });
  });
};

export const decodeCollaborationModes = (result: unknown): CollaborationMode[] => {
  if (!isRecord(result)) return [];
  return list(result.data).flatMap((m) => {
    if (!isRecord(m)) return [];
    const mode = str(m.mode);
    if (mode === undefined) return [];
    return [
      {
        mode,
        model: str(m.model) ?? null,
        reasoningEffort: str(m.reasoning_effort) ?? null,
      },
    ];
  });
};

/** `hook/started` and `hook/completed` both carry `{ threadId, turnId, run }`. */
export const decodeHookRun = (params: unknown): CodexHookRun | null => {
  if (!isRecord(params) || !isRecord(params.run)) return null;
  const eventName = str(params.run.eventName);
  if (eventName === undefined) return null;
  return { eventName, status: str(params.run.status) ?? "running" };
};

/** The assistant text an `item/completed` frame carries, when it is one. */
export const decodeAgentMessage = (params: unknown): string | null => {
  if (!isRecord(params) || !isRecord(params.item)) return null;
  if (params.item.type !== "agentMessage") return null;
  return str(params.item.text) ?? null;
};

export const decodeQuestions = (params: unknown): ToolUserInputQuestion[] => {
  if (!isRecord(params)) return [];
  return list(params.questions).flatMap((q) => {
    if (!isRecord(q)) return [];
    const id = str(q.id);
    if (id === undefined) return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) => {
          if (!isRecord(o)) return [];
          const label = str(o.label);
          if (label === undefined) return [];
          return [{ label, description: str(o.description) ?? "" }];
        })
      : null;
    return [
      {
        id,
        header: str(q.header) ?? "",
        question: str(q.question) ?? "",
        options,
      },
    ];
  });
};

/** The thread id every thread/start and thread/resume response carries. */
export const decodeThreadStart = (
  result: unknown
): { threadId: string; model?: string } | null => {
  if (!isRecord(result) || !isRecord(result.thread)) return null;
  const threadId = str(result.thread.id);
  if (threadId === undefined) return null;
  return { threadId, model: str(result.model) };
};
