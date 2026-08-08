/**
 * Codex app-server protocol, vendored from the ts-rs output of codex-cli
 * 0.147.0 (its `v2` surface). Only the subset the chat transport reads or
 * writes is kept — regenerate from the binary rather than editing by hand.
 *
 * Path-shaped aliases (AbsolutePathBuf, LegacyAppPathString) are plain strings
 * on the wire, so they are inlined as `string`.
 */

// --- lifecycle -------------------------------------------------------------

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type CommandExecutionStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined";
export type PatchApplyStatus = CommandExecutionStatus;
export type ToolCallStatus = "inProgress" | "completed" | "failed";
export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

/** Errors the client reacts to; the rest are reported verbatim. */
export type CodexErrorCode =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "serverOverloaded"
  | "unauthorized"
  | "other";

export interface TurnError {
  message: string;
  codexErrorInfo: unknown;
}

// --- items -----------------------------------------------------------------

export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; move_path: string | null };

export interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

/** The item variants that get a bespoke rendering. Anything else falls back to
 *  a generic tool call keyed on its `type`. */
export type CodexItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: CommandExecutionStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: PatchApplyStatus }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: ToolCallStatus;
      arguments: unknown;
      result: unknown;
      error: unknown;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: unknown;
      status: ToolCallStatus;
      contentItems: unknown;
    }
  | { type: "userMessage"; id: string }
  | {
      type: "collabAgentToolCall";
      id: string;
      tool: CollabAgentTool;
      status: ToolCallStatus;
      /** Threads the call targets. Empty until `spawnAgent` completes. */
      receiverThreadIds: string[];
      prompt: string | null;
      agentsStates: Record<string, CollabAgentState>;
    }
  /** Anything the client has no bespoke shape for. */
  | { type: "unknown"; id: string; kind: string; raw: Record<string, unknown> };

export type CollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent";

export type CollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export interface CollabAgentState {
  status: CollabAgentStatus;
  /** The agent's answer, once it has one. */
  message: string | null;
}

// --- notifications ---------------------------------------------------------

/** Shared by every delta notification the transcript consumes. */
export interface ItemDelta {
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

export interface RateLimitWindow {
  usedPercent: number;
  /** Unix seconds. */
  resetsAt: number | null;
  /** Length of the rolling window; 43200 = 30 days. */
  windowDurationMins: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  rateLimitReachedType: string | null;
  /** Account tier the limits belong to, e.g. "free", "plus", "pro". */
  planType: string | null;
}

/** `thread/list` entry. Only the fields the thread menu shows. */
export interface CodexThread {
  id: string;
  name: string | null;
  preview: string;
  updatedAt: number;
}

/** `model/list` entry. */
export interface CodexModel {
  id: string;
  displayName: string;
  hidden: boolean;
  /** Reasoning efforts the catalog allows for this model, in its own order. */
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
}

/** `collaborationMode/list` entry. The wire shape is flat — the mode's own
 *  settings are spread onto it rather than nested under `settings`. */
export interface CollaborationMode {
  mode: string;
  /** Model the mode pins, or null to keep the thread's. */
  model: string | null;
  reasoningEffort: string | null;
}

/** `skills/list` entry, rendered as a command in the composer's menu. */
export interface CodexSkill {
  name: string;
  description: string;
  /** "user", "repo", "system" or "admin". */
  scope: string;
}

/** Hook events, in the app-server's own camelCase spelling. There is no
 *  `Notification` event — an account block never arrives this way. */
export type CodexHookEvent =
  | "preToolUse"
  | "permissionRequest"
  | "postToolUse"
  | "preCompact"
  | "postCompact"
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmit"
  | "subagentStart"
  | "subagentStop"
  | "stop";

/** The part of `hook/started` and `hook/completed` the status feed reads. */
export interface CodexHookRun {
  eventName: string;
  status: string;
}

// --- server -> client requests ---------------------------------------------

export interface ToolUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[] | null;
}

/** Decisions accepted by both approval requests. The amendment-carrying
 *  variants exist on the wire but the chat pane never offers them. */
export type CodexApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type ElicitationAction = "accept" | "decline" | "cancel";
