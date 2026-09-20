import type { SubagentActivity } from "@/lib/agentStore";
import type { ActivityItem, SessionStatus } from "@/types";
import type { Provider } from "@/lib/providers";
import { describeTool } from "@/lib/toolDisplay";
import type { MessageActivities } from "@/lib/threadPage";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Raw partial JSON accumulated from input_json_delta while streaming. */
  partial: string;
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: ToolCall[];
  /** Assistant messages only: this turn's work as one ordered stream, so
   *  reasoning sits between the tool calls it came between rather than
   *  collapsing into `thinking` above them. Normalized in Rust; the renderer
   *  never reparses a tool input. Absent on a replayed transcript, which still
   *  comes through `parseTranscript`. */
  activities?: ActivityItem[];
  streaming: boolean;
  /** Images the user attached to this turn (user messages only). */
  images?: ChatImage[];
  /** User messages only: the working-tree snapshot taken before this turn was
   *  sent, so its file changes can be reverted on their own. */
  checkpointId?: string;
  /** User messages only: Jev scored this turn's file delta as worth a look. */
  jevReview?: boolean;
  /** Who produced this turn. Stamped by the pane when a thread changes hands,
   *  so a provider switch never relabels what came before it. */
  provider?: Provider;
  /** The model behind `provider`, when it named one. */
  model?: string | null;
  /** Replayed messages only: the provider's own message id for the transcript
   *  line this was built from, used to attach the rows the Rust normalizer
   *  produced for the same line. */
  sourceId?: string;
  /** Assistant messages only: wall-clock start (message_start) and turn end
   *  (result), used to render the "Worked for Ns" turn summary. */
  startedAt?: number;
  endedAt?: number;
}

/** A pasted image, base64-encoded for a stream-json image content block. */
export interface ChatImage {
  id: string;
  mediaType: string;
  /** base64 payload without the data: URL prefix. */
  data: string;
  /** SnapShots sidecar: what was captured and, when "Include app text" was
   *  on, the formatted accessibility tree that rides next to the image on
   *  send — never into the composer's text. */
  snapshot?: { app: string; title: string; a11y?: string };
}

export type ChatStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "awaiting_permission"
  | "awaiting_answer"
  | "retrying"
  | "error"
  | "exited";

/** Chat status → the sidebar's coarse session status (drives its dot colour). */
export const SESSION_STATUS: Record<ChatStatus, SessionStatus> = {
  idle: "idle",
  thinking: "working",
  streaming: "working",
  tool: "working",
  awaiting_permission: "waiting",
  awaiting_answer: "waiting",
  retrying: "working",
  error: "idle",
  exited: "idle",
};

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

/** A pending `can_use_tool` prompt from the CLI awaiting the user's choice. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  /** CLI-computed permission_suggestions, echoed back for "allow always". */
  suggestions: unknown[];
  toolUseId: string;
}

/** A question raised by the agent's `ask_user` MCP tool. The call is blocked in
 *  the backend until `answerAsk` sends a choice back. */
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface PendingAsk {
  id: string;
  /** Always at least one; several render as tabs. */
  questions: AskQuestion[];
}

/** The three answers the plan gate accepts; an unknown one reads as revise. */
export type PlanOutcome = "approved" | "changes" | "abandoned";

/** A plan Grok wants approved before it keeps building. The call is blocked in
 *  the backend until `answerPlan` sends the choice back. Raise only by Grok —
 *  Claude and Codex turn their plan gates at never, hence the noop below. */
export interface PendingPlanApproval {
  requestId: number;
  plan: string;
  toolUseId: string;
}

/** One rolling window an account's quota is measured over. */
export interface QuotaWindow {
  usedPercent: number;
  /** Unix seconds; null when the backend does not say. */
  resetsAt: number | null;
  windowDurationMins: number | null;
}

/** Plan quota for the account driving a session. Only backends that report it
 *  (Codex) populate this; Claude Code exposes nothing equivalent. */
export interface ChatQuota {
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  planType: string | null;
}

const sameWindow = (a: QuotaWindow | null, b: QuotaWindow | null): boolean =>
  a === b ||
  (a != null &&
    b != null &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins);

/** Value equality for a decoded quota. Every `rate_limit_event` builds a new
 *  object, so identity alone would report a change every turn. */
export const sameQuota = (
  a: ChatQuota | undefined,
  b: ChatQuota | undefined
): boolean =>
  a === b ||
  (a != null &&
    b != null &&
    a.planType === b.planType &&
    sameWindow(a.primary, b.primary) &&
    sameWindow(a.secondary, b.secondary));

export interface ChatUsage {
  /** Models offered by a provider session, when its protocol exposes a catalog. */
  models?: { value: string; label: string }[];
  costUsd?: number;
  /** `costUsd` was derived from token counts here, not reported by the
   *  backend. Presenting an estimate as a billed figure would mislead. */
  costEstimated?: boolean;
  quota?: ChatQuota;
  inputTokens?: number;
  outputTokens?: number;
  /** Latest turn's full prompt size (input + cache read + cache creation) —
   *  i.e. how full the context window is right now, not the session total. */
  contextTokens?: number;
  /** Model's total context window, when the backend reports it. */
  contextWindow?: number;
  model?: string;
}

let counter = 0;
export const localId = () => `m${++counter}`;

/** Wire frames are decoded, not trusted. Mirrors `lib/codex/decode.ts`; kept
 *  here so the Claude transport doesn't import a Codex module. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse a Claude Code transcript (`.jsonl`) into the chat message model, so a
 * resumed thread shows its prior turns. Headless `--resume` loads context but
 * never replays past messages on stdout, so we read them from disk instead.
 */
export function parseTranscript(text: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Results arrive lines after their call; indexed so matching one isn't a
  // scan of every message parsed so far. First call with an id owns it.
  const toolsById = new Map<string, ChatMessage["tools"][number]>();
  const attach = (toolUseId: string, result: string, isError: boolean) => {
    const t = toolsById.get(toolUseId);
    if (t) {
      t.result = result;
      t.isError = isError;
    }
  };
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain === true) continue;
    const msg = o.message as Record<string, unknown> | undefined;

    if (o.type === "user" && msg) {
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim() && !isSynthetic(content)) {
          out.push(newMessage("user", { text: content }));
        }
      } else if (Array.isArray(content)) {
        let text = "";
        for (const b of content) {
          if (!isRecord(b)) continue;
          if (b.type === "text") {
            if (typeof b.text === "string") text += b.text;
          } else if (b.type === "tool_result") {
            // An id-less result would `attach` onto the first tool that also
            // has no id — writing one call's output onto another's card.
            if (typeof b.tool_use_id !== "string") continue;
            attach(
              b.tool_use_id,
              typeof b.content === "string" ? b.content : JSON.stringify(b.content),
              Boolean(b.is_error)
            );
          }
        }
        if (text.trim() && !isSynthetic(text)) {
          out.push(newMessage("user", { text }));
        }
      }
    } else if (o.type === "assistant" && msg && Array.isArray(msg.content)) {
      // The key the Rust normalizer buckets this same line under, so the two
      // can be zipped without either side inventing an order. Imported history
      // synthesizes messages with no id, hence the positional fallback — it
      // must match `transcript_activities` exactly.
      const sourceId = typeof msg.id === "string" ? msg.id : `line-${index}`;
      const m = newMessage("assistant", { sourceId });
      for (const b of msg.content) {
        if (!isRecord(b)) continue;
        if (b.type === "text") {
          // `+= undefined` would put the literal string "undefined" in the
          // transcript rather than skipping a malformed block.
          if (typeof b.text === "string") m.text += b.text;
        } else if (b.type === "thinking") {
          if (typeof b.thinking === "string") m.thinking += b.thinking;
        } else if (b.type === "tool_use") {
          // Same id trap as tool_result above: tools are matched to their
          // results by id, so an id-less call collects someone else's output.
          if (typeof b.id !== "string" || typeof b.name !== "string") continue;
          const tool = {
            id: b.id,
            name: b.name,
            input: isRecord(b.input) ? b.input : {},
            partial: "",
          };
          m.tools.push(tool);
          if (!toolsById.has(tool.id)) toolsById.set(tool.id, tool);
        }
      }
      if (m.text || m.thinking || m.tools.length) out.push(m);
    }
  }
  return out;
}

/** Sum token usage and capture the model from a transcript. The transcript
 *  stores per-turn `message.usage` + `message.model` but no cost, so a resumed
 *  thread shows model + tokens; cost fills in after the next live turn.
 *
 *  Context occupancy is not a sum: it is what the *last* turn carried into the
 *  model, cached reads included. Without it a reopened thread reads 0k however
 *  long it is, and the ring only fills once you send again. */
export function parseTranscriptUsage(text: string): ChatUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let contextTokens = 0;
  let model: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain === true || o.type !== "assistant") continue;
    const m = o.message as Record<string, unknown> | undefined;
    if (!m) continue;
    if (typeof m.model === "string") model = m.model;
    const u = m.usage as Record<string, number> | undefined;
    if (u) {
      inputTokens += u.input_tokens ?? 0;
      outputTokens += u.output_tokens ?? 0;
      const ctx =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      // Later lines overwrite earlier ones, so this ends on the last turn.
      if (ctx) contextTokens = ctx;
    }
  }
  return contextTokens
    ? { model, inputTokens, outputTokens, contextTokens }
    : { model, inputTokens, outputTokens };
}

/** CC injects wrapped meta text as "user" turns (slash-command expansions,
 *  local-command caveats, bash-tool i/o, hook output) — not real user input. */
function isSynthetic(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<local-command-") ||
    t.startsWith("<command-") ||
    t.startsWith("<bash-") ||
    t.startsWith("<user-prompt-submit-hook>") ||
    t.startsWith("<task-notification>") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("Caveat: The messages below")
  );
}

export const isAgentTool = (name: unknown): boolean =>
  name === "Task" || name === "Agent";

/** Flatten one subagent turn into the lines the agent panel shows. */
export function readActivity(content: unknown): SubagentActivity[] {
  const out: SubagentActivity[] = [];
  if (!Array.isArray(content)) return out;
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === "tool_use") {
      const d = describeTool(b.name as string, b.input);
      out.push({ kind: "tool", name: d.label, detail: d.title ?? "", icon: d.icon });
    } else if (
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.trim() &&
      !isSynthetic(b.text)
    ) {
      out.push({ kind: "text", name: "", detail: b.text.trim() });
    }
  }
  return out;
}

/**
 * Attach the Rust-normalized rows to the messages the frontend parser built
 * from the same lines — both arrive in one `thread_messages_page` reply.
 *
 * The replay path could have re-derived these in TypeScript, but then a
 * resumed thread and a live one would be describing the same turn through two
 * different implementations — the exact drift the ordered model exists to end.
 * A message with no rows keeps the `thinking` + `tools` fallback.
 */
export const attachTranscriptActivities = (
  messages: ChatMessage[],
  grouped: MessageActivities[]
): ChatMessage[] => {
  if (!grouped.length) return messages;
  const byId = new Map(grouped.map((g) => [g.messageId, g.activities]));
  return messages.map((m) => {
    const rows = m.sourceId ? byId.get(m.sourceId) : undefined;
    return rows?.length ? { ...m, activities: rows } : m;
  });
};

export function newMessage(
  role: "user" | "assistant",
  partial: Partial<ChatMessage>
): ChatMessage {
  return {
    id: localId(),
    role,
    text: "",
    thinking: "",
    tools: [],
    streaming: false,
    ...partial,
  };
}
