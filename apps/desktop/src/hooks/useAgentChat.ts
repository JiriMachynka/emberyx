import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAgentStore, type SubagentActivity } from "@/lib/agentStore";
import { registerAgent, setAgentLifecycle } from "@/lib/agentRegistry";
import { askQuestions, fetchPendingAsk } from "@/lib/approvals";
import { attachCheckpoint, createCheckpoint } from "@/lib/checkpoints";
import { settleTurnCheckpoint } from "@/lib/queries";
import {
  cancelStreamPublish,
  scheduleStreamPublish,
  streamPublishMs,
  type StreamPublishHandle,
} from "@/lib/streamPublish";
import {
  truncateBeforeCheckpoint,
  turnsToDrop,
} from "@/lib/conversationRewind";
import type { PermissionMode } from "@/lib/settings";
import { decodeClaudeQuota } from "@/lib/quota";
import type { Provider } from "@/lib/providers";
import {
  emptyOwnerIndex,
  routeActivities,
  syncOwnerIndex,
  upsertActivities,
} from "@/lib/activities";
import type { ActivityItem, SessionStatus } from "@/types";
import {
  classifyFailure,
  issueTitle,
  resetLabel,
  type AccountIssue,
} from "@/lib/accountState";
import type { AgentBackend } from "@/lib/agentBackend";
import { describeTool } from "@/lib/toolDisplay";
import { notifyNative } from "@/lib/notifications";
import { loadSettings } from "@/lib/settings";
import { snapshotTextBlock } from "@/lib/snapshotA11y";
import { basename } from "@/lib/path";
import { usePromptQueue } from "@/lib/promptQueue";
import {
  ASK_REJECT,
  CONTINUE_PROMPT,
  bumpTurns,
  isDoneCue,
  isKeepGoingOn,
  lastAssistantText,
  shouldContinue,
  wrapOriginatingPrompt,
  type KeepGoing,
} from "@/lib/keepGoing";

/** Paging over the local event store, plus the sidebar's hover prefetch. */
import {
  fetchThreadPage,
  takePrefetchedPage,
  type MessageActivities,
} from "@/lib/threadPage";
import { markPage } from "@/lib/perf";

/** A stream-json line from the headless `claude` process (Rust AgentEvent). */
type AgentEvent =
  | { type: "line"; data: string }
  /** Several stdout lines coalesced by the Rust forwarder into one IPC message. */
  | { type: "lines"; data: string[] }
  /** The work in the lines just sent, normalized in Rust. Rides after those
   *  lines, never instead of them — usage, session ids and permission
   *  requests are still read off the raw stream. */
  | { type: "activities"; data: ActivityItem[] }
  | { type: "stderr"; data: string }
  | { type: "exit"; data: number | null };

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

/** States where the agent can't take a new turn, so one gets queued instead. */
const BUSY_STATUS = new Set<ChatStatus>([
  "thinking",
  "streaming",
  "tool",
  "awaiting_permission",
  "awaiting_answer",
]);

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

/** What `agent_spawn` returns. `reattached` means the daemon already had this
 *  agent and replayed it; `truncated` means the replay is knowingly partial. */
interface AgentHandle {
  id: number;
  reattached: boolean;
  truncated: boolean;
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

interface Options {
  cwd: string;
  /** Emberyx session id (for hook correlation). */
  emberyxSessionId: string;
  /** Agent CLI this chat drives. Only Claude has a transport today, so this
   *  only decides how a failure's wording is read. */
  backend?: AgentBackend;
  /** Claude session id to resume; omit to start fresh. */
  resume?: string;
  /** `resume` names imported history: this app can render the thread from its
   *  event log, but no CLI ever wrote a transcript for it, so the agent starts
   *  fresh and `--resume` is never passed that id. */
  imported?: boolean;
  /** Bypass the permission protocol entirely — no in-chat approval prompts. */
  skipPermissions?: boolean;
  /** Run in `emberyxd` so the agent survives this window closing. */
  persistent?: boolean;
  /** Claude's `--permission-mode`. Only consulted when permissions are not
   *  skipped outright — that flag is mutually exclusive with this one. */
  permissionMode?: PermissionMode;
  /** `--model` alias; "" / undefined lets the CLI pick. Changing it respawns. */
  model?: string;
  /** `--effort` level; "" / undefined lets the CLI pick. It is a session-scoped
   *  launch flag, so changing it respawns the same way the model does. */
  effort?: string;
  /** Binary override + extra args from Settings → Providers. Identity-stable
   *  at the call site — it rides the spawn effect's deps. */
  launch?: {
    command: string | null;
    args: string[];
    configDir?: string | null;
    env?: Record<string, string>;
  };
  /** Called with the generated title once a fresh chat has been auto-titled. */
  onTitled?: (title: string) => void;
  /** False while a session of another backend owns this pane — the hook still
   *  runs (rules of hooks) but spawns nothing and touches no shared state. */
  enabled?: boolean;
  /** False while this pane is mounted but hidden. Token paints skip React;
   *  refs keep accumulating and one flush lands when it is shown again. */
  visible?: boolean;
  /** Unattended continue loop. Read through a ref so bumping turns never
   *  respawns the process. */
  keepGoing?: KeepGoing | null;
  /** Persist a continue that just went on the wire. */
  onKeepGoingTurn?: (next: KeepGoing) => void;
  /** Clear the flag — Stop, or a DONE cue. */
  onKeepGoingStop?: () => void;
}

let counter = 0;
const localId = () => `m${++counter}`;

/** Rolling stderr kept per spawn — enough tail to classify a failure without
 *  holding a chatty run's whole output. */
const STDERR_CAP = 8192;

/** Wire frames are decoded, not trusted. Mirrors `lib/codex/decode.ts`; kept
 *  local so the Claude transport doesn't import a Codex module. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Queue attachments are stored opaquely by the supervisor, so the column can
 *  hold anything an older schema or a truncated write left there. Throwing on
 *  it inside an effect unmounts the whole tree — a queued image is not worth
 *  the window. */
const parseAttachments = (raw: string | null | undefined): ChatImage[] | undefined => {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatImage[]) : undefined;
  } catch {
    return undefined;
  }
};

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

/** Build a SubagentRun from a Task/Agent tool_use input. Shared by the top-level
 *  streamed dispatch and the nested case (an agent spawned inside another). */
function agentRunFrom(id: string, session: string, input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>;
  return {
    id,
    session,
    description: typeof i.description === "string" ? i.description : "Agent",
    subagentType: typeof i.subagent_type === "string" ? i.subagent_type : "",
    prompt: typeof i.prompt === "string" ? i.prompt : "",
    background: i.run_in_background !== false,
  };
}

const isAgentTool = (name: unknown): boolean => name === "Task" || name === "Agent";

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

function newMessage(
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

/**
 * Drives one headless Claude Code process over stream-json and exposes a
 * rendered message model. Parsing lives here; the pane just renders.
 */
export function useAgentChat({
  cwd,
  emberyxSessionId,
  backend = "claude",
  resume,
  imported = false,
  skipPermissions = false,
  persistent = false,
  permissionMode = "acceptEdits",
  model = "",
  effort = "",
  launch,
  onTitled,
  enabled = true,
  visible = true,
  keepGoing = null,
  onKeepGoingTurn,
  onKeepGoingStop,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Mirror for reads inside callbacks (rewind) without stale closures or making
  // the callback re-created — and thus the composer re-rendered — every token.
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  // Which message owns each activity row. Kept alongside the list so a late
  // snapshot is routed by lookup rather than by scanning the whole thread.
  const ownersRef = useRef(emptyOwnerIndex());
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Keyset cursor for paging older history out of the local event store:
  // the position of the oldest message currently held.
  const oldestCursorRef = useRef<{ createdAt: number; messageId: string } | null>(
    null
  );
  /** `cwd::resume` this pane has already hydrated, so the page is read once. */
  const hydratedRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const keepGoingRef = useRef(keepGoing);
  keepGoingRef.current = keepGoing;
  const onKeepGoingTurnRef = useRef(onKeepGoingTurn);
  onKeepGoingTurnRef.current = onKeepGoingTurn;
  const onKeepGoingStopRef = useRef(onKeepGoingStop);
  onKeepGoingStopRef.current = onKeepGoingStop;
  // Live token tally for the turn in flight. A turn is several assistant
  // messages (one per tool-loop hop): `done` holds finished messages, `cur` the
  // streaming one, whose count is restated (not incremented) by message_delta.
  const turnUsageRef = useRef({
    inputDone: 0,
    outputDone: 0,
    curInput: 0,
    curOutput: 0,
    active: false,
  });
  // Running total across every turn this session (prior turns, hydrated from
  // the transcript on resume, plus each completed live turn added on top).
  const sessionUsageRef = useRef({ input: 0, output: 0 });
  const [ready, setReady] = useState(false);
  // Whether this pane wants a process at all. Opening a thread used to launch a
  // CLI on the frame that switches panes — a second of work before the empty
  // screen could paint. Stay asleep until the user types or sends; a persistent
  // one may have a live daemon agent to reattach to, so those still spawn now.
  const [awake, setAwake] = useState(() => persistent);
  const wake = useCallback(() => setAwake(true), []);
  // A turn accepted before the process existed. Delivered by the effect below
  // the moment the spawn lands; further turns queue normally, since the status
  // is already busy by then.
  const pendingSendRef = useRef<{ text: string; images?: ChatImage[] } | null>(
    null
  );
  // Bumped by `restart` to re-run the spawn effect for the same target.
  const [attempt, setAttempt] = useState(0);
  // A session that dies before it has been used at all is almost always a boot
  // problem, not the work failing — several agents start at once when a window
  // restores its projects. Retry that once, silently, rather than greeting the
  // user with a dead session they never touched. Reset when a turn is sent, so
  // the retry can't mask a session failing under real use.
  const bootRetryRef = useRef(0);
  const usedRef = useRef(false);
  // Why the process died, when it wasn't a known account issue — the tail of its
  // stderr. A bare "Session ended" is a dead end; this says what to fix.
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  // Mirror of pendingPermission for reads inside callbacks without stale closures.
  const pendingRef = useRef<PendingPermission | null>(null);
  const setPending = useCallback((p: PendingPermission | null) => {
    pendingRef.current = p;
    setPendingPermission(p);
  }, []);

  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  // Mirror for reads inside callbacks, same reason as pendingRef above.
  const askRef = useRef<PendingAsk | null>(null);
  askRef.current = pendingAsk;

  // The checkpoint this pane's newest turn is running under — set when the
  // send-time snapshot lands, read when the turn settles.
  const lastCheckpointIdRef = useRef<string | null>(null);

  // Subagent runs are telemetry, not transcript — they live in the store so the
  // agent panel and the chip row can subscribe without re-rendering the chat.
  const startSubagent = useAgentStore((st) => st.startSubagent);
  const addSubagentActivity = useAgentStore((st) => st.addSubagentActivity);
  const endSubagent = useAgentStore((st) => st.endSubagent);
  const endOpenSubagents = useAgentStore((st) => st.endOpenSubagents);
  const pushNotification = useAgentStore((st) => st.pushNotification);
  const reportAccountIssue = useAgentStore((st) => st.reportAccountIssue);
  const setSessionStatus = useAgentStore((st) => st.setStatus);

  // Read through a ref so `applyStatus` stays identity-stable: it is called
  // from callbacks all over this file, and a new identity per `enabled` would
  // have to be threaded through every one of their dependency lists.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /** Set the chat's status and mirror it into the store in the same breath.
   *  This used to be an effect over `status`, which needed a cleanup to reset —
   *  and that cleanup ran on every thinking -> streaming -> tool step, so the
   *  store saw working -> idle -> working and restarted the run clock the
   *  "Working 12s" readout measures. A status change is an event, not a
   *  lifetime, so it is written where it happens. */
  const applyStatus = useCallback(
    (next: ChatStatus) => {
      setStatus(next);
      if (!enabledRef.current) return;
      // Keep-going threads stay "working" in the sidebar between continues so
      // LRU unmount cannot drop the pane on the idle gap.
      const sticky =
        next === "idle" && isKeepGoingOn(keepGoingRef.current, usageRef.current);
      setSessionStatus(emberyxSessionId, sticky ? "working" : SESSION_STATUS[next]);
      void setAgentLifecycle(emberyxSessionId, next);
    },
    [emberyxSessionId, setSessionStatus]
  );

  // Idle belongs to the pane going away, which is the one thing that really is
  // a lifetime, not an event.
  useEffect(() => {
    if (!enabled) return;
    return () => setSessionStatus(emberyxSessionId, "idle");
  }, [enabled, emberyxSessionId, setSessionStatus]);

  const clearAccountIssue = useAgentStore((st) => st.clearAccountIssue);

  // Turns typed while the agent was busy. The queue itself is owned by the Rust
  // supervisor (survives restarts, pauses when blocked); React keeps a mirror so
  // rewind can drop the newest queued item synchronously. Each entry carries the
  // runtime queueId once the enqueue round-trip lands.
  const [queued, setQueued] = useState(0);
  const queueRef = useRef<{ queueId: string | null; text: string; images?: ChatImage[] }[]>([]);
  // Mirror of status for reads inside callbacks without stale closures.
  const statusRef = useRef<ChatStatus>("idle");
  statusRef.current = status;

  // Runtime-owned queue for this thread: enqueue/drain go through the
  // supervisor, not React state.
  const promptQueue = usePromptQueue(emberyxSessionId);
  // Reconcile the runtime list (round-trips) into the mirror — but keep ids so
  // rewind's optimistic drop can still remove the right item.
  useEffect(() => {
    const runtime = promptQueue.items;
    for (let i = 0; i < runtime.length; i++) {
      const p = runtime[i];
      const existing = queueRef.current[i];
      queueRef.current[i] = {
        queueId: p.queueId,
        text: p.text,
        images: parseAttachments(p.attachments),
      };
      if (existing && existing.text === p.text) queueRef.current[i].queueId = p.queueId;
    }
    queueRef.current.length = runtime.length;
    setQueued(runtime.length);
  }, [promptQueue.items]);

  // Set while a queue drain is in flight — see the drain effect below.
  const drainingRef = useRef(false);
  const idRef = useRef<number | null>(null);
  // Set while an exit is the user's own doing (stop/rewind). Interrupting makes
  // the headless CLI exit, and "Session ended." is the wrong story for that.
  const interruptedRef = useRef(false);
  // Imported history has no CLI session behind it, so the pane starts without
  // one and adopts whatever id the fresh agent reports.
  const sessionRef = useRef<string | undefined>(imported ? undefined : resume);
  // Set when rewind dropped every turn: the next spawn must not `--resume` the
  // session we just emptied, even though the pane's `resume` prop still names it.
  const clearedResumeRef = useRef(false);
  // The CLI's own thread id, published so the pane can register the thread with
  // the sidebar before the first turn (and its transcript on disk) exists.
  // Imported history has no CLI session, same as sessionRef, until the fresh
  // agent reports one — otherwise the imported-history banner never appears.
  const [threadId, setThreadId] = useState<string | undefined>(
    imported ? undefined : resume
  );
  // The assistant message currently being streamed, plus block-index → tool map.
  const draftRef = useRef<ChatMessage | null>(null);
  const blockToolRef = useRef<Record<number, number>>({});
  // First user message + one-shot guard for auto-titling a fresh chat.
  const firstMsgRef = useRef<string>("");
  const titledRef = useRef(false);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;

  // The draft is mutated on every token but published to React at most ~8 Hz;
  // these track what a paint still owes and the pending rAF/timeout.
  const frameRef = useRef<StreamPublishHandle | null>(null);
  const lastPublishRef = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const draftDirtyRef = useRef(false);
  const usageDirtyRef = useRef(false);
  // Last published copy of each live tool, keyed by tool_use id. Downstream
  // memoisation compares tool identity, so unchanged tools must keep theirs.
  const toolSnapsRef = useRef<Map<string, ToolCall>>(new Map());

  const snapshotTools = useCallback((draft: ChatMessage): ToolCall[] => {
    const snaps = toolSnapsRef.current;
    return draft.tools.map((t) => {
      const prev = snaps.get(t.id);
      if (
        prev &&
        prev.name === t.name &&
        prev.input === t.input &&
        prev.partial === t.partial &&
        prev.result === t.result &&
        prev.isError === t.isError
      ) {
        return prev;
      }
      const copy = { ...t };
      snaps.set(t.id, copy);
      return copy;
    });
  }, []);

  const publishTurnUsage = useCallback(() => {
    const t = turnUsageRef.current;
    const s = sessionUsageRef.current;
    const inputTokens = s.input + t.inputDone + t.curInput;
    const outputTokens = s.output + t.outputDone + t.curOutput;
    // Nothing counted yet — leave the badge as it was rather than showing 0.
    if (!inputTokens && !outputTokens) return;
    setUsage((u) =>
      u.inputTokens === inputTokens && u.outputTokens === outputTokens
        ? u
        : { ...u, inputTokens, outputTokens }
    );
  }, []);

  const cancelFrame = useCallback(() => {
    cancelStreamPublish(frameRef.current);
    frameRef.current = null;
  }, []);

  /** Publish everything the pending frame owed, right now. */
  const flushPending = useCallback(() => {
    cancelFrame();
    if (!visibleRef.current) return;
    lastPublishRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (draftDirtyRef.current) {
      draftDirtyRef.current = false;
      const draft = draftRef.current;
      if (draft) {
        const snapshot = { ...draft, tools: snapshotTools(draft) };
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === draft.id);
          if (i === -1) return [...prev, snapshot];
          const next = prev.slice();
          next[i] = snapshot;
          return next;
        });
      }
    }
    if (usageDirtyRef.current) {
      usageDirtyRef.current = false;
      publishTurnUsage();
    }
  }, [cancelFrame, snapshotTools, publishTurnUsage]);

  const scheduleFlush = useCallback(() => {
    frameRef.current = scheduleStreamPublish(frameRef.current, {
      lastAt: lastPublishRef.current,
      intervalMs: streamPublishMs(),
      visible: visibleRef.current,
      flush: () => {
        frameRef.current = null;
        flushPending();
      },
    });
  }, [flushPending]);

  const flushDraft = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) return;
    // This finalize supersedes any queued frame's draft snapshot.
    cancelFrame();
    draftDirtyRef.current = false;
    if (usageDirtyRef.current) {
      usageDirtyRef.current = false;
      publishTurnUsage();
    }
    const finalized = { ...draft, streaming: false, tools: snapshotTools(draft) };
    draftRef.current = null;
    blockToolRef.current = {};
    toolSnapsRef.current.clear();
    // pushDraft already inserted this draft (by id) during streaming, so replace
    // it in place — appending would duplicate the message and collide on key.
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === finalized.id);
      if (i === -1) {
        const empty =
          !finalized.text &&
          !finalized.thinking &&
          finalized.tools.length === 0 &&
          !finalized.activities?.length;
        return empty ? prev : [...prev, finalized];
      }
      const next = prev.slice();
      next[i] = finalized;
      return next;
    });
  }, [cancelFrame, publishTurnUsage, snapshotTools]);

  const pushDraft = useCallback(
    (patch: (d: ChatMessage) => void) => {
      const draft = draftRef.current;
      if (!draft) return;
      patch(draft);
      draftDirtyRef.current = true;
      scheduleFlush();
    },
    [scheduleFlush]
  );

  /** Fold row snapshots into the message that owns them. The routing and the
   *  merge are pure — see `lib/activities.ts`; this only applies the result to
   *  the draft and to React state. */
  const applyActivities = useCallback(
    (items: ActivityItem[]) => {
      const index = syncOwnerIndex(ownersRef.current, messagesRef.current);
      const routing = routeActivities(items, draftRef.current, index);
      if (routing.draft.length) {
        pushDraft((d) => {
          d.activities = upsertActivities(d.activities, routing.draft);
        });
      }
      if (routing.settled.size) {
        setMessages((prev) => {
          let next = prev;
          for (const [id, mine] of routing.settled) {
            const i = next.findIndex((m) => m.id === id);
            if (i === -1) continue;
            if (next === prev) next = prev.slice();
            next[i] = { ...next[i], activities: upsertActivities(next[i].activities, mine) };
          }
          return next;
        });
      }
    },
    [pushDraft]
  );

  // Reached through a ref, not the spawn effect's dependency list: adding it
  // there would tear down and respawn the `claude` process every time this
  // callback's identity changed.
  const applyActivitiesRef = useRef(applyActivities);
  applyActivitiesRef.current = applyActivities;

  const scheduleUsage = useCallback(() => {
    usageDirtyRef.current = true;
    scheduleFlush();
  }, [scheduleFlush]);

  // A queued frame can only render into a live component; drop it on unmount.
  useEffect(() => cancelFrame, [cancelFrame]);

  // Hidden panes skip token paints; show the backlog on reveal.
  useEffect(() => {
    if (visible) flushPending();
  }, [visible, flushPending]);

  /** Record an account-level failure and announce it in the generic error's
   *  place — "usage limit reached" is actionable, "ended with an error" isn't. */
  const announceIssue = useCallback(
    (issue: AccountIssue) => {
      reportAccountIssue(emberyxSessionId, issue);
      const kind = issue.kind === "rate_limit" ? "rate-limited" : "logged-out";
      const title = issueTitle(issue);
      const reset = resetLabel(issue);
      const body = reset ? `${issue.message} — ${reset}` : issue.message;
      const settings = loadSettings();
      pushNotification({
        session: emberyxSessionId,
        project: basename(cwd),
        kind,
        title,
        body,
      });
      void notifyNative(settings, kind, title, body);
    },
    [cwd, emberyxSessionId, pushNotification, reportAccountIssue]
  );

  const handleLine = useCallback(
    (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const type = msg.type as string;

      // Stop has already flipped the pane idle. Further tokens would put it
      // back on "Responding…" and keep the square button spinning until the
      // CLI happens to notice the interrupt. Result/exit still settle usage.
      if (
        interruptedRef.current &&
        type !== "result" &&
        type !== "system" &&
        type !== "control_cancel_request"
      ) {
        return;
      }

      if (type === "system" && msg.subtype === "init") {
        const sid = msg.session_id as string | undefined;
        if (sid) {
          sessionRef.current = sid;
          setThreadId(sid);
        }
        return;
      }

      if (type === "control_request") {
        const req = msg.request as Record<string, unknown> | undefined;
        if (req?.subtype === "can_use_tool") {
          setPending({
            requestId: msg.request_id as string,
            toolName: req.tool_name as string,
            input: req.input,
            suggestions: (req.permission_suggestions as unknown[]) ?? [],
            toolUseId: req.tool_use_id as string,
          });
          applyStatus("awaiting_permission");
        }
        return;
      }

      if (type === "control_cancel_request") {
        const rid = msg.request_id as string;
        if (pendingRef.current?.requestId === rid) setPending(null);
        return;
      }

      if (type === "stream_event") {
        if (!isRecord(msg.event)) return;
        const ev = msg.event;
        const evType = typeof ev.type === "string" ? ev.type : "";
        if (evType === "message_start") {
          draftRef.current = {
            id: localId(),
            role: "assistant",
            text: "",
            thinking: "",
            tools: [],
            streaming: true,
            startedAt: Date.now(),
          };
          blockToolRef.current = {};
          const message = ev.message as Record<string, unknown> | undefined;
          const model = message?.model as string | undefined;
          // A fresh usage object per assistant message would defeat the
          // composer's memo once a turn, for a model that almost never changes.
          if (model) setUsage((u) => (u.model === model ? u : { ...u, model }));
          const t = turnUsageRef.current;
          if (!t.active) {
            t.active = true;
            t.inputDone = 0;
            t.outputDone = 0;
          }
          const mu = message?.usage as Record<string, number> | undefined;
          t.curInput = mu?.input_tokens ?? 0;
          t.curOutput = mu?.output_tokens ?? 0;
          // Context occupancy is the whole prompt fed to the model — cached
          // reads dominate a long thread, so input_tokens alone understates it.
          const ctx =
            (mu?.input_tokens ?? 0) +
            (mu?.cache_read_input_tokens ?? 0) +
            (mu?.cache_creation_input_tokens ?? 0);
          if (ctx) {
            setUsage((u) => (u.contextTokens === ctx ? u : { ...u, contextTokens: ctx }));
          }
          scheduleUsage();
          applyStatus("thinking");
        } else if (evType === "content_block_start") {
          const index = ev.index as number;
          if (!isRecord(ev.content_block)) return;
          const block = ev.content_block;
          if (block.type === "tool_use") {
            pushDraft((d) => {
              blockToolRef.current[index] = d.tools.length;
              d.tools.push({
                id: block.id as string,
                name: block.name as string,
                input: {},
                partial: "",
              });
            });
            applyStatus("tool");
          }
        } else if (evType === "content_block_delta") {
          const index = ev.index as number;
          if (!isRecord(ev.delta)) return;
          const delta = ev.delta;
          const dType = typeof delta.type === "string" ? delta.type : "";
          if (dType === "text_delta") {
            applyStatus("streaming");
            if (typeof delta.text !== "string") return;
            const text = delta.text;
            pushDraft((d) => {
              d.text += text;
            });
          } else if (dType === "thinking_delta") {
            if (typeof delta.thinking !== "string") return;
            const thinking = delta.thinking;
            pushDraft((d) => {
              d.thinking += thinking;
            });
          } else if (dType === "input_json_delta") {
            pushDraft((d) => {
              const ti = blockToolRef.current[index];
              if (ti != null && d.tools[ti]) {
                d.tools[ti].partial += delta.partial_json as string;
              }
            });
          }
        } else if (evType === "content_block_stop") {
          const index = ev.index as number;
          pushDraft((d) => {
            const ti = blockToolRef.current[index];
            if (ti != null && d.tools[ti]) {
              const tool = d.tools[ti];
              try {
                tool.input = JSON.parse(tool.partial || "{}");
              } catch {
                /* keep partial */
              }
              if (isAgentTool(tool.name)) {
                startSubagent(agentRunFrom(tool.id, emberyxSessionId, tool.input));
              }
            }
          });
        } else if (evType === "message_delta") {
          const mu = ev.usage as Record<string, number> | undefined;
          const t = turnUsageRef.current;
          if (mu?.output_tokens != null) t.curOutput = mu.output_tokens;
          if (mu?.input_tokens != null) t.curInput = mu.input_tokens;
          scheduleUsage();
        } else if (evType === "message_stop") {
          const t = turnUsageRef.current;
          t.inputDone += t.curInput;
          t.outputDone += t.curOutput;
          t.curInput = 0;
          t.curOutput = 0;
          flushDraft();
        }
        return;
      }

      // Turns produced by a subagent carry the dispatching tool's id. They are
      // not part of this thread's transcript — they feed the agent panel.
      const parent = msg.parent_tool_use_id;
      if (typeof parent === "string" && parent) {
        if (type === "assistant") {
          const inner = (msg.message as Record<string, unknown>)?.content;
          addSubagentActivity(parent, ...readActivity(inner));
          // A Task/Agent tool_use *inside* a subagent turn is a nested run —
          // register it so it gets its own chip and captures its own activity.
          if (Array.isArray(inner)) {
            for (const b of inner as Array<Record<string, unknown>>) {
              if (b.type === "tool_use" && isAgentTool(b.name) && typeof b.id === "string") {
                startSubagent(agentRunFrom(b.id, emberyxSessionId, b.input));
              }
            }
          }
        } else if (type === "user") {
          // A nested run's result closes out here — it never reaches the
          // top-level tool_result branch below.
          const content = (msg.message as Record<string, unknown>)?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "tool_result") {
                endSubagent(block.tool_use_id as string, Boolean(block.is_error));
              }
            }
          }
        }
        return;
      }

      // Tool results arrive as a `user` message with tool_result content blocks.
      if (type === "user") {
        const content = (msg.message as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_result") {
              // Background runs have no correlatable completion signal — their
              // launch-ack tool_result must NOT end them (that pins duration to
              // ~0s). They resolve on the turn's `result` instead. Foreground
              // runs end here as normal.
              const run = useAgentStore.getState().subagents[
                block.tool_use_id as string
              ];
              if (!run?.background) {
                endSubagent(block.tool_use_id as string, Boolean(block.is_error));
              }
              attachToolResult(
                setMessages,
                block.tool_use_id as string,
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
                Boolean(block.is_error)
              );
            }
          }
        }
        return;
      }

      // Claude's plan windows ride the same stream, once per turn. Codex sends
      // its own over the app-server; this is the Claude half of the same chip.
      if (type === "rate_limit_event") {
        const quota = decodeClaudeQuota(msg);
        // Decoded fresh every turn, but the numbers only move when a window
        // does — compare by value so an unchanged quota keeps `usage` stable.
        if (quota) setUsage((u) => (sameQuota(u.quota, quota) ? u : { ...u, quota }));
        return;
      }

      if (type === "result") {
        const t = turnUsageRef.current;
        const s = sessionUsageRef.current;
        const ru = msg.usage as Record<string, number> | undefined;
        // `result` only carries this turn's tokens; fold them into the running
        // session total instead of replacing it. Falls back to the live tally
        // when a run ends without a usage object (errors, aborts). Read before
        // the reset below, since the state updater runs later.
        s.input += ru?.input_tokens ?? t.inputDone + t.curInput;
        s.output += ru?.output_tokens ?? t.outputDone + t.curOutput;
        setUsage((u) => ({
          ...u,
          costUsd: msg.total_cost_usd as number | undefined,
          inputTokens: s.input,
          outputTokens: s.output,
        }));
        // `result` is authoritative — drop the tally a queued frame would restate.
        usageDirtyRef.current = false;
        t.active = false;
        t.inputDone = 0;
        t.outputDone = 0;
        t.curInput = 0;
        t.curOutput = 0;
        // The CLI names the failure ("error_max_turns", "error_during_execution"),
        // it never emits a bare "error".
        // A turn the user stopped ends as `error_during_execution` too. That is
        // not a failed session — the process is alive and sendable — so it must
        // not raise an error notice or the pane's "Session failed" dead end.
        const subtype = msg.subtype;
        const failed =
          typeof subtype === "string" &&
          subtype.startsWith("error") &&
          !interruptedRef.current;
        applyStatus(failed ? "error" : "idle");
        // Only the failure is announced here; the Stop hook covers success.
        if (failed) {
          const detail = typeof msg.result === "string" ? msg.result : "";
          const issue = classifyFailure(detail, "result", backend);
          if (issue) {
            announceIssue(issue);
          } else {
            const project = basename(cwd);
            const title = `${project} — error`;
            const body = "The agent run ended with an error";
            const settings = loadSettings();
            if (settings.notifyOnError) {
              pushNotification({
                session: emberyxSessionId,
                project,
                kind: "error",
                title,
                body,
              });
            }
            void notifyNative(settings, "error", title, body);
          }
        } else {
          // A completed turn is the only proof the account works again.
          clearAccountIssue();
        }
        // Stamp the turn's end on its last assistant message so the transcript
        // can show "Worked for Ns".
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].endedAt == null) {
              const copy = prev.slice();
              copy[i] = { ...copy[i], endedAt: Date.now() };
              return copy;
            }
          }
          return prev;
        });
        // The turn is over — resolve any background runs still marked open,
        // since they never get a per-completion signal.
        endOpenSubagents(emberyxSessionId);
        // Freeze this turn's file delta: snapshot the tree now under the
        // turn's checkpoint, so edits made between turns land in no turn's
        // card. Best-effort; a missed settle only widens the range.
        const settledId = lastCheckpointIdRef.current;
        if (settledId) void settleTurnCheckpoint(cwd, settledId);
        return;
      }
    },
    [
      flushDraft,
      pushDraft,
      scheduleUsage,
      emberyxSessionId,
      cwd,
      startSubagent,
      addSubagentActivity,
      endSubagent,
      endOpenSubagents,
      pushNotification,
      announceIssue,
      clearAccountIssue,
    ]
  );

  // On resume, hydrate prior turns from the local event store (headless
  // --resume never replays them). Only fills when the list is still empty so it
  // can't clobber freshly streamed messages. Rows carry raw provider lines, so
  // `parseTranscript` — the same parser the live stream feeds — rebuilds rich
  // messages (tools, thinking) without a second implementation.
  //
  // Skipped in persistent mode: the daemon replays its own buffer, and the two
  // overlap — the CLI writes the same turns to disk as they stream. Rendering
  // both would duplicate the conversation, so the daemon's replay is the single
  // source and resuming an older thread starts visually empty. Imported history
  // is the exception: no daemon buffer can hold turns this app never ran, so
  // there is nothing to double up with.
  useEffect(() => {
    if (!enabled || !resume || (persistent && !imported)) return;
    // Prepending is not idempotent, so a re-run for a target already hydrated
    // (a dependency identity change, StrictMode's second mount) must not
    // stack the same page on top of itself.
    const target = `${cwd}::${resume}`;
    if (hydratedRef.current === target) return;
    hydratedRef.current = target;
    let cancelled = false;
    void (async () => {
      try {
        // The sidebar starts this page on hover; when it did, the switch pays
        // no round trip at all. Either way the read skips the freshness pass —
        // `transcripts_ingest` below does it after the thread is on screen.
        const page = await (takePrefetchedPage(cwd, resume) ??
          fetchThreadPage(cwd, resume, { fresh: false }));
        if (cancelled) return;
        const lines = page.rows
          .map((row) => row.payloadJson)
          .filter((line): line is string => typeof line === "string");
        const transcript = lines.join("\n");
        // Activities come in the same reply, so the turns paint once, already
        // ordered — not painted and then re-rendered when a second trip lands.
        const parsed = attachTranscriptActivities(parseTranscript(transcript), page.activities);
        const oldest = page.rows[0];
        oldestCursorRef.current = oldest
          ? { createdAt: oldest.createdAt, messageId: oldest.messageId }
          : null;
        setHasMore(page.hasMore);
        // Prepend, never discard. The page is this thread's history up to the
        // resume point and the CLI never replays it on stdout, so anything
        // already in `messages` is strictly newer — dropping the page because
        // a live event won the race is how a resumed thread lost every turn
        // before the one you just sent.
        if (parsed.length) setMessages((prev) => [...parsed, ...prev]);
        markPage();
        const hu = parseTranscriptUsage(transcript);
        setUsage((prev) => {
          if (prev.model || prev.costUsd != null || prev.outputTokens != null) {
            // A live turn already restated everything except this: the meter
            // reads 0k until the *next* message_start otherwise.
            return prev.contextTokens != null || hu.contextTokens == null
              ? prev
              : { ...prev, contextTokens: hu.contextTokens };
          }
          // A partial page is not the session total — only commit tokens when
          // everything fit in this page, otherwise keep the model and wait for
          // a live turn to restate usage.
          if (page.hasMore) {
            return hu.model ? { model: hu.model } : prev;
          }
          sessionUsageRef.current = {
            input: hu.inputTokens ?? 0,
            output: hu.outputTokens ?? 0,
          };
          return hu;
        });

        // Now that the thread is on screen, catch the projections up. This is
        // the pass the read above skipped, and it matters for turns written
        // outside this pane — a terminal session, another window, a run from
        // before the app started. A re-read only replaces what was hydrated
        // while nothing else has touched the list: once a live turn has
        // arrived, merging two views of the same tail is how a thread gets its
        // turns twice.
        const summary = await invoke<{ filesChanged: number }>(
          "transcripts_ingest",
          { cwd }
        ).catch(() => null);
        if (cancelled || !summary?.filesChanged) return;
        const fresher = await fetchThreadPage(cwd, resume);
        if (cancelled) return;
        const freshLines = fresher.rows
          .map((row) => row.payloadJson)
          .filter((line): line is string => typeof line === "string");
        if (freshLines.length === lines.length) return;
        const reparsed = attachTranscriptActivities(
          parseTranscript(freshLines.join("\n")),
          fresher.activities
        );
        setMessages((prev) => (prev.length === parsed.length ? reparsed : prev));
        setHasMore(fresher.hasMore);
        const freshOldest = fresher.rows[0];
        oldestCursorRef.current = freshOldest
          ? { createdAt: freshOldest.createdAt, messageId: freshOldest.messageId }
          : oldestCursorRef.current;
      } catch (e) {
        // Let a later mount retry; a failed read must not look hydrated.
        hydratedRef.current = null;
        console.error("[emberyx] thread_messages_page failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, resume, imported, cwd, persistent]);

  const loadOlder = useCallback(async () => {
    if (!enabled || !resume || (persistent && !imported)) return false;
    // No cursor yet means hydration hasn't run (or the thread has no history).
    if (loadingOlderRef.current || !oldestCursorRef.current) return false;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const cursor = oldestCursorRef.current;
      const page = await fetchThreadPage(cwd, resume, {
        beforeCreatedAt: cursor.createdAt,
        beforeMessageId: cursor.messageId,
      });
      const first = page.rows[0];
      oldestCursorRef.current = first
        ? { createdAt: first.createdAt, messageId: first.messageId }
        : null;
      setHasMore(page.hasMore);
      const lines = page.rows
        .map((row) => row.payloadJson)
        .filter((line): line is string => typeof line === "string");
      const older = attachTranscriptActivities(
        parseTranscript(lines.join("\n")),
        page.activities
      );
      if (older.length) setMessages((prev) => [...older, ...prev]);
      return true;
    } catch (e) {
      console.error("[emberyx] thread_messages_page older failed", e);
      return false;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [enabled, resume, imported, cwd, persistent]);

  // Spawn the process once per (cwd, resume) target, once the pane is awake.
  useEffect(() => {
    if (!enabled || !awake) return;
    let disposed = false;
    const channel = new Channel<AgentEvent>();
    // Chunks arrive split mid-line, so the buffer — not the chunk — is what gets
    // classified, and only the first hit per spawn is announced.
    let stderr = "";
    let announced = false;
    interruptedRef.current = false;
    const checkStderr = () => {
      if (announced) return;
      const issue = classifyFailure(stderr, "stderr", backend);
      if (!issue) return;
      announced = true;
      announceIssue(issue);
    };
    channel.onmessage = (ev) => {
      // Ignore late events from a torn-down effect (StrictMode double-mount kills
      // the first agent; its Exit must not flip the live session to "exited").
      if (disposed) return;
      // One malformed frame must not abort the rest of a batch: dropping the
      // remaining lines loses `message_stop`, which leaves the draft streaming
      // forever and hangs the pane mid-turn.
      const safeLine = (line: string) => {
        try {
          handleLine(line);
        } catch (e) {
          console.error("[emberyx] dropped unparsable agent frame", e);
        }
      };
      if (ev.type === "line") safeLine(ev.data);
      else if (ev.type === "lines") for (const line of ev.data) safeLine(line);
      else if (ev.type === "activities") {
        try {
          applyActivitiesRef.current(ev.data);
        } catch (e) {
          // The raw lines already landed; a bad row must not take the turn
          // down with it.
          console.error("[emberyx] dropped agent activity frame", e);
        }
      } else if (ev.type === "stderr") {
        stderr = (stderr + ev.data).slice(-STDERR_CAP);
        checkStderr();
      } else if (ev.type === "exit") {
        // Nothing is left to answer them: a prompt outliving its process would
        // replace the composer permanently.
        setPending(null);
        setPendingAsk(null);
        if (interruptedRef.current) {
          // The user asked for this. Stay idle and quietly respawn against the
          // same thread id so the transcript stays live and sendable.
          interruptedRef.current = false;
          applyStatus("idle");
          setAttempt((n) => n + 1);
          return;
        }
        if (!usedRef.current && bootRetryRef.current < 1) {
          bootRetryRef.current += 1;
          applyStatus("idle");
          setAttempt((n) => n + 1);
          return;
        }
        applyStatus("exited");
        // A crash often says why only on stderr, and never reaches `result`.
        if (ev.data !== 0) {
          checkStderr();
          // Show the reason unless it was already routed to an account notice.
          if (!announced) {
            const lines = stderr.trim().split("\n").filter(Boolean);
            setExitReason(lines[lines.length - 1] ?? null);
          }
        }
      }
    };

    void (async () => {
      try {
        const resumeAt = clearedResumeRef.current
          ? null
          : sessionRef.current ?? (imported ? null : resume) ?? null;
        clearedResumeRef.current = false;
        const handle = await invoke<AgentHandle>("agent_spawn", {
          cwd,
          sessionId: crypto.randomUUID(),
          // Prefer the live session id so a respawn (model switch, restart)
          // resumes the same thread instead of starting a fresh one.
          resume: resumeAt,
          permissionMode,
          skipPermissions,
          settings: null,
          model: model || null,
          effort: effort || null,
          command: launch?.command ?? null,
          extraArgs: launch?.args ?? [],
          configDir: launch?.configDir ?? null,
          env: launch?.env ?? {},
          emberyxSessionId,
          persistent,
          // Always replay the daemon's whole buffer: in persistent mode it is
          // the only source for the rendered transcript.
          afterFrameId: null,
          onEvent: channel,
        });
        const id = handle.id;
        if (disposed) {
          void invoke(persistent ? "agent_detach" : "agent_kill", { id });
          return;
        }
        if (handle.truncated) {
          setExitReason(
            "The agent ran longer than the daemon keeps output for — the start of this transcript is missing."
          );
        }
        idRef.current = id;
        void registerAgent(emberyxSessionId, cwd, "claude", id);
        // The queue is keyed by thread id; attach this session so the runtime
        // knows which thread's queue to pause when the agent is blocked.
        void invoke("agent_attach_thread", {
          agentId: emberyxSessionId,
          threadId: emberyxSessionId,
        });
        setReady(true);
      } catch (e) {
        console.error("[emberyx] agent_spawn failed", e);
        setPending(null);
        setPendingAsk(null);
        if (!usedRef.current && bootRetryRef.current < 1) {
          bootRetryRef.current += 1;
          setAttempt((n) => n + 1);
          return;
        }
        applyStatus("error");
        // Without this the pane says only "Session failed." — true, useless, and
        // indistinguishable between a missing CLI and a bad flag.
        setExitReason(String(e));
      }
    })();

    return () => {
      disposed = true;
      setReady(false);
      if (idRef.current !== null) {
        // Persistent agents are detached, never killed: the pane closing is not
        // the user asking the agent to stop.
        void invoke(persistent ? "agent_detach" : "agent_kill", {
          id: idRef.current,
        });
        idRef.current = null;
      }
    };
  }, [
    enabled,
    awake,
    cwd,
    resume,
    imported,
    skipPermissions,
    model,
    effort,
    launch,
    emberyxSessionId,
    persistent,
    permissionMode,
    handleLine,
    announceIssue,
    setPending,
    attempt,
  ]);

  // Respawn the same thread in place. A dead session used to be recoverable only
  // by opening a new chat, which loses the transcript the user was reading.
  const restart = useCallback(() => {
    interruptedRef.current = false;
    bootRetryRef.current = 0;
    setAwake(true);
    applyStatus("idle");
    setPending(null);
    setPendingAsk(null);
    setExitReason(null);
    setAttempt((n) => n + 1);
  }, [setPending]);

  /**
   * Write a line to the agent. A rejected send is the one failure that must not
   * be silent: the caller has already flipped the status to "thinking" and shown
   * the user's message, so swallowing it leaves the pane thinking forever with
   * the composer disabled and no way out but closing the tab. `fatal` marks the
   * sends that carry a turn — an interrupt that fails has already set its own
   * terminal state.
   */
  const sendLine = useCallback((id: number, line: string, fatal: boolean) => {
    void invoke("agent_send", { id, message: line }).catch((e) => {
      console.error("[emberyx] agent_send failed", e);
      if (!fatal) return;
      applyStatus("error");
      setExitReason(e instanceof Error ? e.message : String(e));
    });
  }, []);

  // Abort the current turn with a real `interrupt` control_request. Some CLI
  // versions keep the process alive, others exit — either way the exit is ours,
  // so flag it and the exit handler respawns instead of showing a dead end.
  const interrupt = useCallback(() => {
    const id = idRef.current;
    if (id !== null) {
      interruptedRef.current = true;
      const line = JSON.stringify({
        type: "control_request",
        request_id: crypto.randomUUID(),
        request: { subtype: "interrupt" },
      });
      sendLine(id, line, false);
    }
    setPending(null);
    applyStatus("idle");
  }, [setPending, sendLine]);

  // Stop the current turn, keeping everything it already produced.
  const stop = useCallback(() => {
    // A send that hasn't reached stdin yet (spawn still in flight) must not
    // go out after the user already hit stop.
    pendingSendRef.current = null;
    interruptedRef.current = true;
    if (keepGoingRef.current) {
      keepGoingRef.current = null;
      onKeepGoingStopRef.current?.();
    }
    // No further tokens are coming — publish what the frame still owed.
    flushPending();
    if (idRef.current === null) {
      applyStatus("idle");
      return;
    }
    interrupt();
  }, [interrupt, flushPending]);

  // Stop the newest turn. A turn that never produced anything is un-sent — it
  // leaves the transcript and its text/images are handed back for the composer
  // to restore. Once the assistant has said or done something that reply is
  // worth keeping, so this degrades to a plain stop and returns null. No-op once
  // idle, so it never eats a finished exchange.
  const rewind = useCallback((): { text: string; images?: ChatImage[] } | null => {
    if (!BUSY_STATUS.has(statusRef.current) && queueRef.current.length === 0) {
      return null;
    }
    // No further tokens are coming — publish what the frame still owed, so the
    // "produced nothing" test below sees the last partial frame too.
    flushPending();
    const msgs = messagesRef.current;
    const idx = msgs.map((m) => m.role).lastIndexOf("user");
    if (idx === -1) return null;
    const restored = { text: msgs[idx].text, images: msgs[idx].images };

    if (queueRef.current.length > 0) {
      // Newest turn never left the queue — drop it from the runtime queue,
      // leave the active run. The count drops optimistically; the runtime's
      // next list reconcile is the source of truth.
      const newest = queueRef.current.pop();
      setQueued((n) => Math.max(0, n - 1));
      if (newest && newest.queueId) void promptQueue.remove(newest.queueId);
      setMessages(msgs.slice(0, idx));
      return restored;
    }

    const draft = draftRef.current;
    const produced =
      !!draft && (!!draft.text || !!draft.thinking || draft.tools.length > 0);
    interrupt();
    if (produced) return null;
    setMessages(msgs.slice(0, idx));
    return restored;
  }, [interrupt, flushPending, promptQueue]);

  // Answer a pending can_use_tool prompt: allow (once/always) or deny.
  const respond = useCallback(
    (decision: PermissionDecision) => {
      const id = idRef.current;
      const pending = pendingRef.current;
      if (id === null || pending === null) return;
      const inner =
        decision === "deny"
          ? {
              behavior: "deny",
              message: "User declined.",
              interrupt: true,
              toolUseID: pending.toolUseId,
            }
          : {
              behavior: "allow",
              updatedInput: pending.input,
              toolUseID: pending.toolUseId,
              ...(decision === "allow_always"
                ? { updatedPermissions: pending.suggestions }
                : {}),
            };
      const line = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: pending.requestId,
          response: inner,
        },
      });
      // Allowing a tool puts the turn back in flight, so a failed write here
      // deadlocks the pane exactly the way a failed prompt does.
      sendLine(id, line, decision !== "deny");
      setPending(null);
      applyStatus(decision === "deny" ? "idle" : "thinking");
    },
    [setPending, sendLine]
  );

  // `ask_user` questions arrive as a Tauri event (the tool call blocks in Rust,
  // not on the stream-json wire), tagged with the session that asked.
  useEffect(() => {
    if (!enabled) return;
    // The event fires once. A question raised while this pane was closed is
    // still blocking the agent, so read the open ones back rather than leaving
    // it waiting on a prompt nothing is showing.
    // The read-back is a round trip into the supervisor. If the pane's session
    // changed before it lands, its answer belongs to a question this pane never
    // asked — showing it would cover the composer with someone else's prompt.
    let cancelled = false;
    const rejectUnattended = (id: string) => {
      void invoke("answer_ask", { id, answer: ASK_REJECT });
      applyStatus("thinking");
    };
    void fetchPendingAsk(emberyxSessionId)
      .then((pending) => {
        if (cancelled || !pending || askRef.current) return;
        if (isKeepGoingOn(keepGoingRef.current, usageRef.current)) {
          rejectUnattended(pending.id);
          return;
        }
        setPendingAsk(pending);
        applyStatus("awaiting_answer");
      })
      .catch((e) => console.error("[emberyx] pending ask read failed", e));
    const unlisten = listen<unknown>("ask-user", (ev) => {
      if (cancelled) return;
      const payload = ev.payload;
      if (!isRecord(payload) || payload.session !== emberyxSessionId) return;
      if (typeof payload.id !== "string") return;
      // A live event is no more trustworthy than the persisted payload.
      const questions = askQuestions(payload);
      if (!questions) {
        console.error("[emberyx] unanswerable ask-user payload", payload);
        return;
      }
      if (isKeepGoingOn(keepGoingRef.current, usageRef.current)) {
        rejectUnattended(payload.id);
        return;
      }
      setPendingAsk({ id: payload.id, questions });
      applyStatus("awaiting_answer");
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [enabled, emberyxSessionId]);

  /** Hand a choice back to the blocked tool call. */
  const answerAsk = useCallback((answer: string) => {
    const pending = askRef.current;
    if (!pending) return;
    setPendingAsk(null);
    void invoke("answer_ask", { id: pending.id, answer });
    applyStatus("thinking");
  }, []);

  /** Put a turn on the wire. Callers must have checked the agent is free. */
  const deliver = useCallback(
    (text: string, images?: ChatImage[]) => {
    const id = idRef.current;
    const hasImages = !!images && images.length > 0;
    if (id === null) return;
    applyStatus("thinking");
    // Snapshot the tree before the turn touches it. Fired here rather than in
    // `send` so a queued turn is covered too, and never awaited: a checkpoint
    // is a safety net, not a precondition for the turn the user asked for.
    void createCheckpoint(cwd, emberyxSessionId, text).then((point) => {
      if (point) {
        lastCheckpointIdRef.current = point.id;
        setMessages((prev) => attachCheckpoint(prev, point.id));
      }
    });
    const content = hasImages
      ? [
          ...(text.trim() ? [{ type: "text", text }] : []),
          ...images.flatMap((img) => [
            {
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.data },
            },
            // A snapshot's accessibility tree follows its image, so the agent
            // reads labels instead of guessing from pixels. A plain pasted
            // image carries nothing extra.
            ...(img.snapshot
              ? [{ type: "text", text: snapshotTextBlock(img.snapshot) }]
              : []),
          ]),
        ]
      : text;
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    sendLine(id, line, true);
    },
    [cwd, emberyxSessionId, sendLine]
  );

  /**
   * Accept a turn at any time. While the agent is working the message is shown
   * in the transcript straight away and held until the run finishes, so typing
   * never has to wait for the agent.
   */
  const send = useCallback(
    (text: string, images?: ChatImage[]) => {
      const id = idRef.current;
      const hasImages = !!images && images.length > 0;
      if (!enabled || (!text.trim() && !hasImages)) return;
      // A new turn outlives the last interrupt; a later exit is a real failure.
      interruptedRef.current = false;
      // From here on the session has been used: a death is worth reporting, not
      // silently retrying.
      usedRef.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: localId(),
          role: "user",
          text,
          thinking: "",
          tools: [],
          streaming: false,
          images: hasImages ? images : undefined,
        },
      ]);
      if (!firstMsgRef.current && text.trim()) firstMsgRef.current = text;
      let wire = text;
      const flag = keepGoingRef.current;
      if (isKeepGoingOn(flag, usageRef.current, Date.now()) && flag && !flag.wrapped) {
        wire = wrapOriginatingPrompt(text);
        const next = { ...flag, wrapped: true };
        keepGoingRef.current = next;
        onKeepGoingTurnRef.current?.(next);
      }
      if (id === null && !pendingSendRef.current) {
        // No process yet — this is the turn that wakes the pane. Hold it (the
        // transcript already shows it) and go busy, so anything sent while the
        // spawn is in flight takes the queue path below instead of racing it.
        pendingSendRef.current = { text: wire, images };
        applyStatus("thinking");
        wake();
        return;
      }
      if (BUSY_STATUS.has(statusRef.current)) {
        // The runtime owns the queue — React keeps a synchronous mirror for the
        // composer count and rewind. The runtime queueId lands once the enqueue
        // round-trip resolves; until then the entry is identifiable by text.
        const attachments = hasImages ? JSON.stringify(images) : undefined;
        setQueued((n) => n + 1);
        queueRef.current.push({ queueId: null, text: wire, images });
        void promptQueue.enqueue(wire, attachments, emberyxSessionId);
        return;
      }
      deliver(wire, images);
    },
    [deliver, promptQueue, emberyxSessionId, enabled, wake]
  );

  // The turn that woke the pane goes on the wire as soon as the spawn lands.
  useEffect(() => {
    if (!ready) return;
    const held = pendingSendRef.current;
    if (!held) return;
    pendingSendRef.current = null;
    deliver(held.text, held.images);
  }, [ready, deliver]);

  const compact = useCallback(() => {
    send("/compact");
  }, [send]);

  // Drain one queued turn each time the agent goes idle. The runtime queue pops
  // the head — and stays paused while the agent is blocked — so this only
  // dispatches what the supervisor is ready for. The count drops optimistically;
  // the runtime's next list reconcile is the source of truth.
  const keepGoingOn = isKeepGoingOn(keepGoing, usage);
  useEffect(() => {
    if (status !== "idle") {
      // Held true across the idle→thinking transition so a Strict-Mode double
      // invoke of this effect cannot inject two continues for one idle.
      drainingRef.current = false;
      return;
    }
    // `promptQueue` gets a new identity whenever its items change — which
    // `runNext` itself causes, as does every agent event. Without this guard the
    // effect re-enters mid-drain, two pops race, and the second turn goes on the
    // wire during the first.
    if (drainingRef.current) return;
    if (queueRef.current.length > 0) {
      drainingRef.current = true;
      let cancelled = false;
      void promptQueue
        .runNext()
        .then((next) => {
          if (cancelled || !next) return;
          // Shift the mirror in step with the runtime pop so rewind never sees a
          // stale head.
          queueRef.current.shift();
          setQueued((n) => Math.max(0, n - 1));
          deliver(next.text, parseAttachments(next.attachments));
        })
        .catch((e) => console.error("[emberyx] queue drain failed", e))
        .finally(() => {
          drainingRef.current = false;
        });
      return () => {
        cancelled = true;
      };
    }
    const flag = keepGoingRef.current;
    const last = lastAssistantText(messagesRef.current);
    if (
      !flag ||
      !shouldContinue({
        flag,
        queueEmpty: true,
        status: "idle",
        usage: usageRef.current,
        now: Date.now(),
        lastAssistantText: last,
        hasUserTurn: messagesRef.current.some((m) => m.role === "user"),
      })
    ) {
      if (flag && last && isDoneCue(last)) {
        keepGoingRef.current = null;
        onKeepGoingStopRef.current?.();
        // applyStatus("idle") ran sticky-working while the flag was still on.
        applyStatus("idle");
      }
      return;
    }
    drainingRef.current = true;
    const next = bumpTurns(flag);
    keepGoingRef.current = next;
    onKeepGoingTurnRef.current?.(next);
    deliver(CONTINUE_PROMPT);
  }, [status, deliver, promptQueue, keepGoingOn, applyStatus]);

  // Auto-title a fresh chat after its first turn completes (headless CC never
  // titles a session itself). Skipped for resumed threads (already titled).
  useEffect(() => {
    if (status !== "idle" || (resume && !imported) || titledRef.current) return;
    const sid = sessionRef.current;
    const first = firstMsgRef.current;
    if (!sid || !first) return;
    titledRef.current = true;
    void invoke<string>("title_thread", {
      cwd,
      sessionId: sid,
      firstMessage: first,
    })
      .then((title) => {
        if (title) onTitledRef.current?.(title);
      })
      .catch((e) => console.error("[emberyx] title_thread failed", e));
  }, [status, resume, imported, cwd]);

  /** Drop this user turn and everything after it from Claude's transcript, then
   *  respawn so the next prompt resumes the truncated session. Git restore is
   *  the caller's job — this is only the provider half of Revert turn. */
  const revertTurn = useCallback(
    async (checkpointId: string) => {
      const sid = sessionRef.current;
      const drop = turnsToDrop(messagesRef.current, checkpointId);
      if (!sid || drop === null || drop < 1) return;
      const result = await invoke<{ sessionId: string | null }>(
        "claude_session_rewind",
        {
          cwd,
          sessionId: sid,
          dropTurns: drop,
          configDir: launch?.configDir ?? null,
        }
      );
      const next = truncateBeforeCheckpoint(messagesRef.current, checkpointId);
      messagesRef.current = next;
      setMessages(next);
      if (result.sessionId) {
        sessionRef.current = result.sessionId;
        setThreadId(result.sessionId);
        clearedResumeRef.current = false;
      } else {
        sessionRef.current = undefined;
        setThreadId(undefined);
        clearedResumeRef.current = true;
      }
      restart();
    },
    [cwd, launch, restart]
  );

  return {
    messages,
    status,
    usage,
    ready,
    // Not started *yet*, as opposed to starting: the composer must stay live in
    // this state or the keystroke that wakes the pane can never be typed.
    asleep: !awake,
    wake,
    threadId,
    send,
    compact,
    queued,
    queue: promptQueue,
    stop,
    restart,
    exitReason,
    // Claude folds the model into its spawn arguments, so a model it rejects
    // ends the session with a reason rather than quietly running another one.
    modelError: null as string | null,
    rewind,
    revertTurn,
    pendingPermission,
    respond,
    pendingPlan: null,
    answerPlan: notifyPlanNothing,
    pendingAsk,
    answerAsk,
    hasMore,
    loadingOlder,
    loadOlder,
  };
}

/** The three chat hooks expose one shape to the pane; Claude and Codex never
 *  raise the plan gate, so theirs is permanent absence. */
export const notifyPlanNothing = (_outcome: PlanOutcome, _comments: string) => {};

function attachToolResult(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  toolUseId: string,
  result: string,
  isError: boolean
) {
  setMessages((prev) => {
    // Results land on the most recent calls, so scan from the end and copy only
    // the one message that owns the tool.
    for (let i = prev.length - 1; i >= 0; i--) {
      const ti = prev[i].tools.findIndex((t) => t.id === toolUseId);
      if (ti === -1) continue;
      const tools = prev[i].tools.slice();
      tools[ti] = { ...tools[ti], result, isError };
      const next = prev.slice();
      next[i] = { ...prev[i], tools };
      return next;
    }
    return prev;
  });
}
