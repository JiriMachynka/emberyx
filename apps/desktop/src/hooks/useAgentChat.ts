import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAgentStore, type SubagentActivity } from "@/lib/agentStore";
import { registerAgent, setAgentLifecycle } from "@/lib/agentRegistry";
import { fetchPendingAsk } from "@/lib/approvals";
import { attachCheckpoint, createCheckpoint } from "@/lib/checkpoints";
import type { PermissionMode } from "@/lib/settings";
import type { Provider } from "@/lib/providers";
import type { SessionStatus } from "@/types";
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
import { basename } from "@/lib/path";
import { usePromptQueue } from "@/lib/promptQueue";

/** One projected message row from `thread_messages_page`. */
interface ProjectedMessageRow {
  messageId: string;
  threadId: string;
  role: string;
  text: string;
  provider?: string | null;
  createdAt: number;
  payloadJson: string | null;
}

interface MessagePage {
  rows: ProjectedMessageRow[];
  hasMore: boolean;
}

/** Messages fetched per "load older" page from the local event store. */
const THREAD_PAGE_LIMIT = 60;

/** A stream-json line from the headless `claude` process (Rust AgentEvent). */
type AgentEvent =
  | { type: "line"; data: string }
  /** Several stdout lines coalesced by the Rust forwarder into one IPC message. */
  | { type: "lines"; data: string[] }
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
}

let counter = 0;
const localId = () => `m${++counter}`;

/** Rolling stderr kept per spawn — enough tail to classify a failure without
 *  holding a chatty run's whole output. */
const STDERR_CAP = 8192;

/**
 * Parse a Claude Code transcript (`.jsonl`) into the chat message model, so a
 * resumed thread shows its prior turns. Headless `--resume` loads context but
 * never replays past messages on stdout, so we read them from disk instead.
 */
export function parseTranscript(text: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const attach = (toolUseId: string, result: string, isError: boolean) => {
    for (const m of out) {
      const t = m.tools.find((x) => x.id === toolUseId);
      if (t) {
        t.result = result;
        t.isError = isError;
        return;
      }
    }
  };
  for (const line of text.split("\n")) {
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
          if (b?.type === "text") text += b.text as string;
          else if (b?.type === "tool_result") {
            attach(
              b.tool_use_id as string,
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
      const m = newMessage("assistant", {});
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === "text") m.text += b.text as string;
        else if (b.type === "thinking") m.thinking += b.thinking as string;
        else if (b.type === "tool_use") {
          m.tools.push({
            id: b.id as string,
            name: b.name as string,
            input: b.input ?? {},
            partial: "",
          });
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
  skipPermissions = false,
  persistent = false,
  permissionMode = "acceptEdits",
  model = "",
  effort = "",
  launch,
  onTitled,
  enabled = true,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Mirror for reads inside callbacks (rewind) without stale closures or making
  // the callback re-created — and thus the composer re-rendered — every token.
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
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

  // Subagent runs are telemetry, not transcript — they live in the store so the
  // agent panel and the chip row can subscribe without re-rendering the chat.
  const startSubagent = useAgentStore((st) => st.startSubagent);
  const addSubagentActivity = useAgentStore((st) => st.addSubagentActivity);
  const endSubagent = useAgentStore((st) => st.endSubagent);
  const endOpenSubagents = useAgentStore((st) => st.endOpenSubagents);
  const pushNotification = useAgentStore((st) => st.pushNotification);
  const reportAccountIssue = useAgentStore((st) => st.reportAccountIssue);
  const setSessionStatus = useAgentStore((st) => st.setStatus);

  // Mirror the chat's live status into the global store so the sidebar dot can
  // turn orange while Claude works. Reset to idle on unmount.
  useEffect(() => {
    if (!enabled) return;
    setSessionStatus(emberyxSessionId, SESSION_STATUS[status]);
    void setAgentLifecycle(emberyxSessionId, status);
    return () => setSessionStatus(emberyxSessionId, "idle");
  }, [enabled, status, emberyxSessionId, setSessionStatus]);
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
        images: p.attachments ? (JSON.parse(p.attachments) as ChatImage[]) : undefined,
      };
      if (existing && existing.text === p.text) queueRef.current[i].queueId = p.queueId;
    }
    queueRef.current.length = runtime.length;
    setQueued(runtime.length);
  }, [promptQueue.items]);

  const idRef = useRef<number | null>(null);
  // Set while an exit is the user's own doing (stop/rewind). Interrupting makes
  // the headless CLI exit, and "Session ended." is the wrong story for that.
  const interruptedRef = useRef(false);
  const sessionRef = useRef<string | undefined>(resume);
  // The CLI's own thread id, published so the pane can register the thread with
  // the sidebar before the first turn (and its transcript on disk) exists.
  const [threadId, setThreadId] = useState<string | undefined>(resume);
  // The assistant message currently being streamed, plus block-index → tool map.
  const draftRef = useRef<ChatMessage | null>(null);
  const blockToolRef = useRef<Record<number, number>>({});
  // First user message + one-shot guard for auto-titling a fresh chat.
  const firstMsgRef = useRef<string>("");
  const titledRef = useRef(false);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;

  // The draft is mutated on every token but published to React at most once per
  // animation frame; these track what a frame still owes and the frame itself.
  const frameRef = useRef<number | null>(null);
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
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  /** Publish everything the pending frame owed, right now. */
  const flushPending = useCallback(() => {
    cancelFrame();
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
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      flushPending();
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
          !finalized.text && !finalized.thinking && finalized.tools.length === 0;
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

  const scheduleUsage = useCallback(() => {
    usageDirtyRef.current = true;
    scheduleFlush();
  }, [scheduleFlush]);

  // A queued frame can only render into a live component; drop it on unmount.
  useEffect(() => cancelFrame, [cancelFrame]);

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
          setStatus("awaiting_permission");
        }
        return;
      }

      if (type === "control_cancel_request") {
        const rid = msg.request_id as string;
        if (pendingRef.current?.requestId === rid) setPending(null);
        return;
      }

      if (type === "stream_event") {
        const ev = msg.event as Record<string, unknown>;
        const evType = ev.type as string;
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
          if (model) setUsage((u) => ({ ...u, model }));
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
          setStatus("thinking");
        } else if (evType === "content_block_start") {
          const index = ev.index as number;
          const block = ev.content_block as Record<string, unknown>;
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
            setStatus("tool");
          }
        } else if (evType === "content_block_delta") {
          const index = ev.index as number;
          const delta = ev.delta as Record<string, unknown>;
          const dType = delta.type as string;
          if (dType === "text_delta") {
            setStatus("streaming");
            pushDraft((d) => {
              d.text += delta.text as string;
            });
          } else if (dType === "thinking_delta") {
            pushDraft((d) => {
              d.thinking += delta.thinking as string;
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
          for (const activity of readActivity(inner)) {
            addSubagentActivity(parent, activity);
          }
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
        setStatus(failed ? "error" : "idle");
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
  // source and resuming an older thread starts visually empty.
  useEffect(() => {
    if (!enabled || !resume || persistent) return;
    // Prepending is not idempotent, so a re-run for a target already hydrated
    // (a dependency identity change, StrictMode's second mount) must not
    // stack the same page on top of itself.
    const target = `${cwd}::${resume}`;
    if (hydratedRef.current === target) return;
    hydratedRef.current = target;
    let cancelled = false;
    void (async () => {
      try {
        const page = await invoke<MessagePage>("thread_messages_page", {
          cwd,
          threadId: resume,
          limit: THREAD_PAGE_LIMIT,
        });
        if (cancelled) return;
        const lines = page.rows
          .map((row) => row.payloadJson)
          .filter((line): line is string => typeof line === "string");
        const transcript = lines.join("\n");
        const parsed = parseTranscript(transcript);
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
      } catch (e) {
        // Let a later mount retry; a failed read must not look hydrated.
        hydratedRef.current = null;
        console.error("[emberyx] thread_messages_page failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, resume, cwd, persistent]);

  const loadOlder = useCallback(async () => {
    if (!enabled || !resume || persistent) return false;
    // No cursor yet means hydration hasn't run (or the thread has no history).
    if (loadingOlderRef.current || !oldestCursorRef.current) return false;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const cursor = oldestCursorRef.current;
      const page = await invoke<MessagePage>("thread_messages_page", {
        cwd,
        threadId: resume,
        beforeCreatedAt: cursor.createdAt,
        beforeMessageId: cursor.messageId,
        limit: THREAD_PAGE_LIMIT,
      });
      const first = page.rows[0];
      oldestCursorRef.current = first
        ? { createdAt: first.createdAt, messageId: first.messageId }
        : null;
      setHasMore(page.hasMore);
      const lines = page.rows
        .map((row) => row.payloadJson)
        .filter((line): line is string => typeof line === "string");
      const older = parseTranscript(lines.join("\n"));
      if (older.length) setMessages((prev) => [...older, ...prev]);
      return true;
    } catch (e) {
      console.error("[emberyx] thread_messages_page older failed", e);
      return false;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [enabled, resume, cwd, persistent]);

  // Spawn the process once per (cwd, resume) target.
  useEffect(() => {
    if (!enabled) return;
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
      if (ev.type === "line") handleLine(ev.data);
      else if (ev.type === "lines") for (const line of ev.data) handleLine(line);
      else if (ev.type === "stderr") {
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
          setStatus("idle");
          setAttempt((n) => n + 1);
          return;
        }
        if (!usedRef.current && bootRetryRef.current < 1) {
          bootRetryRef.current += 1;
          setStatus("idle");
          setAttempt((n) => n + 1);
          return;
        }
        setStatus("exited");
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
        const handle = await invoke<AgentHandle>("agent_spawn", {
          cwd,
          sessionId: crypto.randomUUID(),
          // Prefer the live session id so a respawn (model switch, restart)
          // resumes the same thread instead of starting a fresh one.
          resume: sessionRef.current ?? resume ?? null,
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
        setStatus("error");
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
    cwd,
    resume,
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
    setStatus("idle");
    setPending(null);
    setPendingAsk(null);
    setExitReason(null);
    setAttempt((n) => n + 1);
  }, [setPending]);

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
      void invoke("agent_send", { id, message: line });
    }
    setPending(null);
    setStatus("idle");
  }, [setPending]);

  // Stop the current turn, keeping everything it already produced.
  const stop = useCallback(() => {
    if (idRef.current === null) return;
    // No further tokens are coming — publish what the frame still owed.
    flushPending();
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
      void invoke("agent_send", { id, message: line });
      setPending(null);
      setStatus(decision === "deny" ? "idle" : "thinking");
    },
    [setPending]
  );

  // `ask_user` questions arrive as a Tauri event (the tool call blocks in Rust,
  // not on the stream-json wire), tagged with the session that asked.
  useEffect(() => {
    if (!enabled) return;
    // The event fires once. A question raised while this pane was closed is
    // still blocking the agent, so read the open ones back rather than leaving
    // it waiting on a prompt nothing is showing.
    void fetchPendingAsk(emberyxSessionId).then((pending) => {
      if (!pending || askRef.current) return;
      setPendingAsk(pending);
      setStatus("awaiting_answer");
    });
    const unlisten = listen<PendingAsk & { session: string }>("ask-user", (ev) => {
      if (ev.payload.session !== emberyxSessionId) return;
      setPendingAsk(ev.payload);
      setStatus("awaiting_answer");
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [enabled, emberyxSessionId]);

  /** Hand a choice back to the blocked tool call. */
  const answerAsk = useCallback((answer: string) => {
    const pending = askRef.current;
    if (!pending) return;
    setPendingAsk(null);
    void invoke("answer_ask", { id: pending.id, answer });
    setStatus("thinking");
  }, []);

  /** Put a turn on the wire. Callers must have checked the agent is free. */
  const deliver = useCallback(
    (text: string, images?: ChatImage[]) => {
    const id = idRef.current;
    const hasImages = !!images && images.length > 0;
    if (id === null) return;
    setStatus("thinking");
    // Snapshot the tree before the turn touches it. Fired here rather than in
    // `send` so a queued turn is covered too, and never awaited: a checkpoint
    // is a safety net, not a precondition for the turn the user asked for.
    void createCheckpoint(cwd, emberyxSessionId, text).then((point) => {
      if (point) setMessages((prev) => attachCheckpoint(prev, point.id));
    });
    const content = hasImages
      ? [
          ...(text.trim() ? [{ type: "text", text }] : []),
          ...images.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.data },
          })),
        ]
      : text;
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    void invoke("agent_send", { id, message: line });
    },
    [cwd, emberyxSessionId]
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
      if (id === null || (!text.trim() && !hasImages)) return;
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
      if (BUSY_STATUS.has(statusRef.current)) {
        // The runtime owns the queue — React keeps a synchronous mirror for the
        // composer count and rewind. The runtime queueId lands once the enqueue
        // round-trip resolves; until then the entry is identifiable by text.
        const attachments = hasImages ? JSON.stringify(images) : undefined;
        setQueued((n) => n + 1);
        queueRef.current.push({ queueId: null, text, images });
        void promptQueue.enqueue(text, attachments, emberyxSessionId);
        return;
      }
      deliver(text, images);
    },
    [deliver, promptQueue, emberyxSessionId]
  );

  const compact = useCallback(() => {
    send("/compact");
  }, [send]);

  // Drain one queued turn each time the agent goes idle. The runtime queue pops
  // the head — and stays paused while the agent is blocked — so this only
  // dispatches what the supervisor is ready for. The count drops optimistically;
  // the runtime's next list reconcile is the source of truth.
  useEffect(() => {
    if (status !== "idle") return;
    if (queueRef.current.length === 0) return;
    void promptQueue.runNext().then((next) => {
      if (!next) return;
      // Shift the mirror in step with the runtime pop so rewind never sees a
      // stale head.
      queueRef.current.shift();
      setQueued((n) => Math.max(0, n - 1));
      deliver(
        next.text,
        next.attachments ? (JSON.parse(next.attachments) as ChatImage[]) : undefined
      );
    });
  }, [status, deliver, promptQueue]);

  // Auto-title a fresh chat after its first turn completes (headless CC never
  // titles a session itself). Skipped for resumed threads (already titled).
  useEffect(() => {
    if (status !== "idle" || resume || titledRef.current) return;
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
  }, [status, resume, cwd]);

  return {
    messages,
    status,
    usage,
    ready,
    threadId,
    send,
    compact,
    queued,
    queue: promptQueue,
    stop,
    restart,
    exitReason,
    rewind,
    pendingPermission,
    respond,
    pendingAsk,
    answerAsk,
    hasMore,
    loadingOlder,
    loadOlder,
  };
}

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
