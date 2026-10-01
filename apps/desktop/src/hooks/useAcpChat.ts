/**
 * Drives one ACP agent process (OpenCode, Grok) and exposes the same rendered
 * chat model `useAgentChat` does, so the pane consumes any backend without
 * branching.
 *
 * Everything about *what a frame means* lives in `lib/acp/adapter`; this hook
 * owns the process, the channel, the agent's blocked requests, and React state.
 * Turn state is held in a ref and published at most ~8 Hz, so a streaming
 * turn re-renders the pane a handful of times a second, not per token.
 * Hidden panes skip the paint until they are shown again.
 *
 * Two ACP facts shape this file:
 *   * the agent blocks on `session/request_permission` and `fs/*` until they
 *     are answered, so every request is either answered or explicitly refused;
 *   * `session/prompt` replies when the turn *ends*, which arrives here as the
 *     `turnEnded` event rather than as the result of sending. Grok also fires
 *     `_x.ai/session/prompt_complete` first; either one settles the turn.
 *
 * Grok's plan gate is a third blocked request: it intercepts its own
 * `exit_plan_mode` and re-asks it as a vendor ext request (`_x.ai/
 * exit_plan_mode` — `{sessionId, toolCallId, planContent}`, answered with
 * `{outcome: approved|changes|abandoned, comments}`). Unanswered, Grok reads
 * the plan approval as "client disconnected" and never leaves plan mode;
 * `answerPlan` keeps that off the wire.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { askQuestions, fetchPendingAsk } from "@/lib/approvals";
import { parseAttachments, usePromptQueue } from "@/lib/promptQueue";
import { useDaemonHolds } from "@/hooks/useDaemonHolds";
import {
  cancelStreamPublish,
  scheduleStreamPublish,
  streamPublishMs,
  type StreamPublishHandle,
} from "@/lib/streamPublish";
import {
  applyUpdate,
  autoPermission,
  configOptionsOf,
  emptyTurn,
  endTurn,
  grokTurnStop,
  interjectMethod,
  ownsToolCall,
  permissionOutcome,
  readPermission,
  readUsageUpdate,
  sessionUpdateOf,
  type AcpPermission,
  type AcpTurn,
} from "@/lib/acp/adapter";
import type { AcpConfigOption, AcpSessionUpdate } from "@/lib/acp/protocol";
import {
  accessLevelFrom,
  type PermissionMode,
} from "@/lib/settings";
import {
  acpCancel,
  acpDetach,
  acpInterject,
  acpKill,
  acpPrompt,
  acpRespond,
  acpSessionLoad,
  acpSessionNew,
  acpSetConfigOption,
  acpSetModel,
  acpSpawn,
  currentModel,
  effortOption,
  modelOptions,
  type AcpEvent,
  type AcpServerRequest,
} from "@/lib/acp/transport";
import { acpAccountIssue } from "@/lib/accountState";
import { isAgentBackend } from "@/lib/agentBackend";
import { useAgentPhase } from "@/hooks/useAgentPhase";
import { useAccountIssue } from "@/hooks/useAccountIssue";
import { contextForModel } from "@/lib/modelContext";
import { attachCheckpoint, createCheckpoint } from "@/lib/checkpoints";
import { loadThreadHistory, type ProjectedMessageRow } from "@/lib/threadPage";
import { threadTitleFrom } from "@/lib/threadTitle";
import { deniedVendor, splitModelLabel } from "@/lib/modelCatalog";
import { markProviderUnavailable } from "@/lib/modelFavorites";
import { useAgentStore } from "@/lib/agentStore";
import { settleTurn } from "@/lib/turnSettle";
import {
  SESSION_STATUS,
  type ChatImage,
  type ChatMessage,
  type ChatStatus,
  type ChatUsage,
  type PendingAsk,
  type PendingPlanApproval,
  type PendingPermission,
  type PermissionDecision,
  type PlanOutcome,
  type ToolCall,
} from "@/hooks/useAgentChat";
import {
  BUSY_STATUS,
  loadNothing,
  rewindNothing,
  revertNothing,
  type ChatSession,
} from "@/lib/chatSession";
import type { Json, JsonObject } from "@/types";
import { ASK_REJECT, CONTINUE_PROMPT, isKeepGoingOn, type KeepGoing } from "@/lib/keepGoing";
import { useKeepGoing } from "@/hooks/useKeepGoing";

/** Keep the tail of stderr for an exit message; the rest is diagnostics. */
const STDERR_CAP = 4000;

/**
 * Rebuild chat messages from a projected page — the history of a thread the
 * event log owns entirely. Rows are plain: user and assistant text, tool rows
 * carrying the invocation JSON this pane wrote at settle. Tool rows attach to
 * the assistant message that follows them, which is the order the writer
 * emits (prompt, tools, reply), so reopened history renders through the same
 * fallback shape a replayed transcript does.
 */
const messagesFromPage = (rows: ProjectedMessageRow[]): ChatMessage[] => {
  const out: ChatMessage[] = [];
  let pendingTools: ToolCall[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      out.push({
        id: row.messageId,
        role: "user",
        text: row.text,
        thinking: "",
        tools: [],
        streaming: false,
      });
      continue;
    }
    if (row.role === "tool") {
      try {
        const parsed = JSON.parse(row.payloadJson ?? "{}") as {
          name?: string;
          input?: Json;
          result?: string | null;
          isError?: boolean;
        };
        if (parsed.name) {
          pendingTools.push({
            id: row.messageId,
            name: parsed.name,
            input: parsed.input ?? {},
            partial: "",
            // The turn ended before this tool reported, or it reported
            // nothing — either way it is over. A null result would render
            // history as a card that is still running.
            result: parsed.result ?? "",
            isError: parsed.isError || undefined,
          });
        }
      } catch {
        // A row that fails to parse is skipped, not fatal; the rest of the
        // history is still history.
      }
      continue;
    }
    if (row.role === "assistant") {
      out.push({
        id: row.messageId,
        role: "assistant",
        text: row.text,
        thinking: "",
        tools: pendingTools,
        streaming: false,
      });
      pendingTools = [];
    }
  }
  return out;
};

interface Options {
  cwd: string;
  emberyxSessionId: string;
  /** Provider id — the ACP binary to drive (`opencode`, `grok`). */
  provider: string;
  /** ACP session id to resume; omit to open a fresh one. */
  resume?: string;
  /** `resume` is an id this provider issued — the session was opened on it,
   *  not switched to it from another provider — so it is safe to `session/load`
   *  on a fresh mount. */
  resumeOwned?: boolean;
  /** `resume` names imported history, which no provider can load. */
  imported?: boolean;
  /** Model to run, from the picker; "" lets the agent decide. Applied over
   *  `session/set_model` — ACP has no model parameter on `session/new`. */
  model?: string;
  /** Reasoning level from the picker; "" leaves the session on its own. Set
   *  over `session/set_config_option`, and only to a level the session offers
   *  for its current model. */
  effort?: string;
  /** Binary override + extra args from Settings → Providers. Identity-stable
   *  at the call site — it rides the spawn effect's deps. */
  launch?: { command: string | null; args: string[]; env?: Record<string, string> };
  /** Run the agent in `emberyxd` so it survives closing the window. */
  persistent?: boolean;
  /** The composer's access level, as the pair Claude's flags need. ACP has no
   *  spawn-time equivalent, so the level is applied per request in
   *  `handleRequest` instead — see `autoPermission`. */
  skipPermissions?: boolean;
  permissionMode?: PermissionMode;
  enabled: boolean;
  onTitled?: (title: string) => void;
  /** False while this pane is mounted but hidden. Token paints skip React;
   *  refs keep accumulating and one flush lands when it is shown again. */
  visible?: boolean;
  /** Unattended continue loop — same contract as `useAgentChat`. */
  keepGoing?: KeepGoing | null;
  onKeepGoingTurn?: (next: KeepGoing) => void;
  onKeepGoingStop?: () => void;
}

/**
 * Remember a provider that answered a turn with "access denied".
 *
 * OpenCode offers every provider you hold a credential for, and a credential is
 * not an entitlement — a `GITLAB_TOKEN` without a Duo seat lists a dozen Duo
 * models that every turn 403s on. Nothing in the protocol distinguishes the two
 * before a turn runs, so the refusal is the signal, and the picker drops that
 * vendor's models from then on. The name shown is the vendor half of the
 * catalog label ("GitLab Duo/Agentic Chat (…)"), falling back to the id's
 * vendor key when the catalog never labelled the model.
 */
const rememberRefusal = (
  model: string,
  message: string,
  models: ChatUsage["models"]
) => {
  const vendor = deniedVendor(model, message);
  if (vendor === undefined) return;
  const label = models?.find((m) => m.value === model)?.label;
  markProviderUnavailable(vendor, (label && splitModelLabel(label).vendor) ?? vendor);
};

let nextMessageId = 0;
const messageId = (prefix: string) => `acp-${prefix}-${(nextMessageId += 1)}`;

const isRecord = (v: Json): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const windowOf = (
  modelId: string,
  models: { value: string; context?: number }[] | undefined
): number | undefined =>
  contextForModel(modelId, models?.find((m) => m.value === modelId)?.context);

export function useAcpChat({
  cwd,
  emberyxSessionId,
  provider,
  resume,
  resumeOwned = false,
  imported = false,
  model,
  effort = "",
  launch,
  skipPermissions = false,
  permissionMode = "default",
  enabled,
  onTitled,
  visible = true,
  persistent = false,
  keepGoing = null,
  onKeepGoingTurn,
  onKeepGoingStop,
}: Options): ChatSession {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const {
    isOn: unattended,
    wrap: wrapKeepGoing,
    stop: stopKeepGoing,
    idle: keepGoingIdle,
  } = useKeepGoing({ keepGoing, onKeepGoingTurn, onKeepGoingStop });
  const [ready, setReady] = useState(false);
  // Stay asleep until the user types or sends, so switching onto a fresh ACP
  // chat does not wait on spawn to paint the empty screen — unless the daemon
  // already runs this agent, in which case the pane attaches right away to
  // show it.
  const [awake, setAwake] = useState(false);
  const wake = useCallback(() => setAwake(true), []);
  const held = useDaemonHolds(emberyxSessionId, persistent);
  // Read by the spawn effect, which must not re-run when the answer lands.
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => {
    if (held) setAwake(true);
  }, [held]);
  // `text` is the wire form; `raw` what the user typed, before a keep-going wrap.
  const pendingSendRef = useRef<
    { text: string; raw: string; images?: ChatImage[] } | null
  >(null);

  // The supervisor owns this thread's prompt queue, the same runtime Claude
  // queues through — enqueue on busy, drain one per idle.
  const promptQueue = usePromptQueue(emberyxSessionId);
  // `raw` is the text before a keep-going wrap — what the transcript shows.
  const queueRef = useRef<
    { queueId: string | null; text: string; raw: string; images: ChatImage[] | undefined }[]
  >([]);
  const [queued, setQueued] = useState(0);
  // Set while a queue drain is in flight — the queue identity changes on every
  // queue event, and without this guard the effect re-enters mid-drain.
  const drainingRef = useRef(false);
  useEffect(() => {
    const runtime = promptQueue.items;
    for (let i = 0; i < runtime.length; i++) {
      const p = runtime[i];
      const existing = queueRef.current[i];
      queueRef.current[i] =
        existing && existing.text === p.text
          ? { queueId: p.queueId, text: p.text, raw: existing.raw, images: existing.images }
          : { queueId: p.queueId, text: p.text, raw: p.text, images: parseAttachments(p.attachments) };
    }
    queueRef.current.length = runtime.length;
    setQueued(runtime.length);
  }, [promptQueue.items]);
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  /** A plan waiting for approve / request-changes / abandon. Grok blocks the
   *  turn on the ext request until `answerPlan` answers it. */
  const [pendingPlan, setPendingPlan] = useState<PendingPlanApproval | null>(null);
  const pendingPlanRef = useRef<PendingPlanApproval | null>(null);
  pendingPlanRef.current = pendingPlan;
  /** An `ask_user` question the Emberyx MCP server is blocking the turn on.
   *  It never rides the ACP wire — the server is handed to the agent at
   *  `session/new` and the call parks in Rust — so it arrives as a Tauri event. */
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const askRef = useRef<PendingAsk | null>(null);
  askRef.current = pendingAsk;
  const [restartNonce, setRestartNonce] = useState(0);
  /** Set when the agent refused a model switch. The picker would otherwise go on
   *  showing the model you asked for while the session runs another one. */
  const [modelError, setModelError] = useState<string | null>(null);
  /** The session id this provider issued, once it exists. Published so the pane
   *  registers the running thread with the sidebar — without it, a conversation
   *  you are mid-way through is missing from the list for its whole life. It
   *  resumes only inside this pane (`canLoad`); the provider's session store
   *  dies with the child process, so a row reopened elsewhere starts fresh. */
  const [liveThreadId, setLiveThreadId] = useState<string | undefined>(undefined);
  /** The model actually driving the session — the attribution this pane stamps
   *  onto the timeline events it records. */
  const modelRef = useRef("");
  /** The session id this pane has already adopted into the event log. A
   *  restart issues a new id, which is adopted on its first prompt. */
  const adoptedForRef = useRef<string | null>(null);
  // The opening prompt, plus a one-shot guard: the sidebar is told the name
  // once, after the first turn settles. Reading it in a ref keeps the titling
  // effect off the send path's deps.
  const firstMsgRef = useRef("");
  const titledRef = useRef(false);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;

  // Committed turns, plus the one being streamed. Held in refs so a token
  // doesn't have to round-trip through React to be folded in.
  const committedRef = useRef<ChatMessage[]>([]);
  // The checkpoint this pane's newest turn is running under — set when the
  // send-time snapshot lands, read when the turn settles.
  const lastCheckpointIdRef = useRef<string | null>(null);
  const turnRef = useRef<AcpTurn>(emptyTurn());
  const frameRef = useRef<StreamPublishHandle | null>(null);
  const lastPublishRef = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const dirtyRef = useRef(false);
  const processRef = useRef<number | null>(null);
  const sessionRef = useRef<string | null>(null);
  const channelRef = useRef<Channel<AcpEvent> | null>(null);
  /** Requests the agent is blocked on, oldest first; the head is the one the
   *  prompt is showing. A queue rather than a scalar because nothing in ACP
   *  says only one may be outstanding — opencode runs tool calls in parallel,
   *  and a second request used to overwrite the first, which was then never
   *  answered and hung the turn until its timeout. */
  const permissionQueueRef = useRef<AcpPermission[]>([]);
  // Held in a ref because `handleRequest` is the channel's handler: putting the
  // level in its deps would rebuild the handler mid-turn. Changing the level
  // takes effect on the next request, with no respawn — unlike Claude and
  // Codex, which carry it into spawn arguments. Written in an effect, not
  // during render: a render that React throws away must not leave the handler
  // answering at a level the user never committed to.
  const access = accessLevelFrom(permissionMode, skipPermissions);
  const accessRef = useRef(access);
  useEffect(() => {
    accessRef.current = access;
  }, [access]);
  // Tool calls this client approved on the user's behalf, so the row can say so
  // rather than looking like the agent was never gated at all.
  const autoApprovedRef = useRef(new Set<string>());
  /** The last session id this provider handed us, which is the only id it can
   *  be asked to load back. Survives a restart of the child within this pane;
   *  nothing outside it stores an ACP session id. */
  const issuedSessionRef = useRef<string | null>(null);
  /** Set while a `session/load` may still be replaying the conversation. The
   *  pane already shows that history from the event log, so replayed turns are
   *  dropped until the user sends — the agent speaks unprompted for no other
   *  reason, and the replay can trail the load reply on the channel. */
  const replayingRef = useRef(false);
  /** `cwd::resume` whose history has been read, so a re-run never prepends it
   *  twice. */
  const seededRef = useRef<string | null>(null);
  /** The model the session is actually on, so a re-render never re-sends
   *  `session/set_model` for a switch that already took. */
  const appliedModelRef = useRef("");
  /** Set while the turn ending is the user's own doing. Agents answer a
   *  cancelled `session/prompt` either way — some with `cancelled`, some with an
   *  error — and a stop the user asked for is not a failed session. */
  const stoppedRef = useRef(false);
  /** A `session/prompt` still waiting on its reply. Grok settles a turn on its
   *  ext notifications *before* replying, so a continue sent in that gap would
   *  have the late reply commit the continue instead — keep-going waits. */
  const [promptOpen, setPromptOpen] = useState(false);
  /** Which config option sets reasoning effort on this session, when one does. */
  const effortConfigIdRef = useRef<string | null>(null);
  /** `model|level` last asked for, so a refused level is never re-sent. */
  const attemptedEffortRef = useRef("");
  /** A refused level, reported the way a refused model is. */
  const [effortError, setEffortError] = useState<string | null>(null);
  /** Messages sent into the running turn, in order, each with the id of the
   *  reply part it cut off. Recorded to the event log when the turn settles,
   *  so the log reads in the order the transcript shows. */
  const steersRef = useRef<{ replyId: string | null; prompt: string }[]>([]);
  /** Replies still owed by prompts sent mid-turn. OpenCode answers every
   *  prompt that joined a turn when the turn ends, all at once; only the last
   *  one settles it. */
  const steerRepliesRef = useRef(0);
  const announceIssue = useAccountIssue(emberyxSessionId, cwd);

  const setSessionStatus = useAgentStore((s) => s.setStatus);

  /** Mirror the chat's status into the store. Called from the publish path
   *  rather than an effect over `status`: an effect needs a cleanup to reset,
   *  and that cleanup ran on every thinking -> streaming -> tool step, so the
   *  store saw working -> idle -> working and restarted the run clock. Writing
   *  at the event also reaches a hidden pane, whose paints are skipped — its
   *  sidebar row used to sit on a stale status until it was shown again. */
  const mirroredStatusRef = useRef<string | null>(null);
  const syncPhase = useAgentPhase(emberyxSessionId, enabled);
  const syncSessionStatus = useCallback(
    (next: ChatStatus) => {
      // Keep-going threads stay "working" between continues so LRU unmount
      // cannot drop the pane on the idle gap — same as Claude.
      const sticky = next === "idle" && unattended(usageRef.current);
      const key = sticky ? "sticky" : next;
      if (!enabled || mirroredStatusRef.current === key) return;
      mirroredStatusRef.current = key;
      setSessionStatus(emberyxSessionId, sticky ? "working" : SESSION_STATUS[next]);
    },
    [enabled, emberyxSessionId, setSessionStatus, unattended]
  );

  // Idle belongs to the pane going away, which is the one thing that really is
  // a lifetime, not an event.
  useEffect(() => {
    if (!enabled) return;
    return () => setSessionStatus(emberyxSessionId, "idle");
  }, [enabled, emberyxSessionId, setSessionStatus]);

  // `ask_user` questions arrive as a Tauri event — the Emberyx MCP server is
  // handed to the agent at `session/new`, and its call parks in Rust rather
  // than riding the ACP wire. The event fires once, tagged with the session
  // that asked, so a question raised while this pane was closed is read back
  // from the supervisor on mount instead of leaving the agent blocked.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Unattended: nobody is there to pick, so the agent is told to decide.
    const rejectUnattended = (id: string) => {
      void invoke("answer_ask", { id, answer: ASK_REJECT });
    };
    void fetchPendingAsk(emberyxSessionId)
      .then((pending) => {
        if (cancelled || !pending || askRef.current) return;
        if (unattended(usageRef.current)) {
          rejectUnattended(pending.id);
          return;
        }
        setPendingAsk(pending);
      })
      .catch((e) => console.error("[emberyx] pending ask read failed", e));
    const unlisten = listen<Json>("ask-user", (ev) => {
      if (cancelled) return;
      const payload = ev.payload;
      if (!isRecord(payload) || payload.session !== emberyxSessionId) return;
      if (typeof payload.id !== "string") return;
      const questions = askQuestions(payload);
      if (!questions) {
        console.error("[emberyx] unanswerable ask-user payload", payload);
        return;
      }
      if (unattended(usageRef.current)) {
        rejectUnattended(payload.id);
        return;
      }
      setPendingAsk({ id: payload.id, questions });
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [enabled, emberyxSessionId, unattended]);

  const cancelFrame = useCallback(() => {
    cancelStreamPublish(frameRef.current);
    frameRef.current = null;
  }, []);

  const publish = useCallback(() => {
    cancelFrame();
    syncSessionStatus(turnRef.current.status);
    syncPhase(turnRef.current.status, turnRef.current.message);
    if (!visibleRef.current) {
      // Status still reaches React: the queue drain and keep-going run off it,
      // and a hidden pane is exactly where an unattended thread works.
      setStatus(turnRef.current.status);
      dirtyRef.current = true;
      return;
    }
    dirtyRef.current = false;
    lastPublishRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const turn = turnRef.current;
    setMessages(
      turn.message ? [...committedRef.current, turn.message] : committedRef.current
    );
    setStatus(turn.status);
  }, [cancelFrame, syncSessionStatus, syncPhase]);

  const schedulePublish = useCallback(() => {
    // Ahead of the paint, and ahead of `publish`'s own hidden-pane bail.
    syncSessionStatus(turnRef.current.status);
    syncPhase(turnRef.current.status, turnRef.current.message);
    dirtyRef.current = true;
    frameRef.current = scheduleStreamPublish(frameRef.current, {
      lastAt: lastPublishRef.current,
      intervalMs: streamPublishMs(),
      visible: visibleRef.current,
      flush: () => {
        frameRef.current = null;
        publish();
      },
    });
  }, [publish, syncSessionStatus, syncPhase]);

  // A queued frame can only render into a live component.
  useEffect(() => cancelFrame, [cancelFrame]);

  useEffect(() => {
    if (!visible) return;
    if (dirtyRef.current) publish();
  }, [visible, publish]);

  /** Show the oldest unanswered request, or nothing when the queue drained.
   *  The turn keeps working while later requests wait their turn. */
  const showHeadPermission = useCallback(() => {
    const head = permissionQueueRef.current[0];
    setPendingPermission(
      head
        ? {
            requestId: String(head.requestId),
            toolName: head.title,
            input: head.description ?? {},
            suggestions: [],
            toolUseId: head.toolCallId ?? "",
          }
        : null
    );
    turnRef.current = {
      ...turnRef.current,
      status: head ? "awaiting_permission" : "tool",
    };
    publish();
  }, [publish]);

  /**
   * Drop every queued request. `answer` tells the agent they were cancelled,
   * which is what ACP asks a client to do on `session/cancel`; a dead or
   * about-to-die process is dropped silently instead, since writing to it
   * either fails or answers a request the next process never made.
   */
  const clearPermissions = useCallback(
    (answer: boolean) => {
      const id = processRef.current;
      const queued = permissionQueueRef.current;
      permissionQueueRef.current = [];
      if (answer && id !== null) {
        for (const permission of queued) {
          void acpRespond(id, permission.requestId, permissionOutcome(null));
        }
      }
      setPendingPermission(null);
    },
    []
  );

  /** One record into the thread timeline. This is what makes an ACP
   *  conversation outlive its pane: the provider keeps no resumable history,
   *  so the event log is the only store there is. */
  const recordTimeline = useCallback(
    (threadId: string, kind: string, payload: string) => {
      void invoke("thread_timeline_append", {
        threadId,
        kind,
        attribution: {
          provider,
          model: modelRef.current || null,
          nativeThreadId: threadId,
        },
        payload,
      }).catch((e) => console.error("[emberyx] timeline append failed", e));
    },
    [provider]
  );

  /** Register a thread with the event log: the project path is what the
   *  sidebar's store listing finds it by, and the source marker is what says
   *  no CLI can ever resume it. Idempotent Rust-side; this side guards it to
   *  once per session id. */
  const adoptThread = useCallback(
    (threadId: string) => {
      void invoke("thread_adopt", {
        threadId,
        projectPath: cwd,
        source: "acp",
      }).catch((e) => console.error("[emberyx] thread_adopt failed", e));
    },
    [cwd]
  );

  /** Fold the streamed turn into the committed transcript.
   *
   *  `sessionStatus` overrides what the stop reason implies for the *session*.
   *  A failed prompt is a failed turn, not a dead session — the agent is still
   *  up and sendable — so it commits as an error for the timeline while the
   *  pane stays idle. Only a process that actually exited is terminal. */
  const commitTurn = useCallback(
    (reason: string, sessionStatus?: ChatStatus) => {
      const ended = endTurn(turnRef.current, reason);
      if (ended.message) committedRef.current = [...committedRef.current, ended.message];
      turnRef.current = { message: null, status: sessionStatus ?? ended.status };
      // The rows carry the flag themselves once committed, so the ids are dead
      // weight past the turn that approved them.
      autoApprovedRef.current.clear();
      publish();
      // Persist the settled turn. The event log is the only durable store an
      // ACP conversation has — the provider keeps no history of its own — so
      // this is recorded or it is gone when the pane closes. Tool rows ride
      // ahead of the reply, which is the order a reopened page reads back in.
      // Reopened history lives under `resume`; the provider's new session id
      // is ephemeral and must not fork a second store thread.
      const logId = resume ?? sessionRef.current;
      const recordReply = (id: string, reply: ChatMessage) => {
        for (const tool of reply.tools) {
          recordTimeline(
            id,
            "toolInvocation",
            JSON.stringify({
              name: tool.name,
              input: tool.input ?? null,
              result: tool.result ?? null,
              isError: tool.isError ?? false,
            })
          );
        }
        if (reply.text.trim()) recordTimeline(id, "assistantResponse", reply.text);
      };
      // Steered parts are recorded only now, so a tool that was still running
      // when the user cut in is logged with the result it later got.
      const steers = steersRef.current;
      steersRef.current = [];
      if (logId) {
        for (const steer of steers) {
          const part = committedRef.current.find((m) => m.id === steer.replyId);
          if (part) recordReply(logId, part);
          recordTimeline(logId, "userPrompt", steer.prompt);
        }
      }
      if (logId && ended.message) recordReply(logId, ended.message);
      if (logId) {
        recordTimeline(
          logId,
          ended.status === "error" ? "error" : "completion",
          JSON.stringify({ stopReason: ended.status === "error" ? reason : ended.status })
        );
      }
      // Freeze this turn's file delta under its checkpoint; see `settleTurn`.
      settleTurn(cwd, lastCheckpointIdRef.current);
    },
    [publish, cwd, recordTimeline, resume, emberyxSessionId]
  );

  /**
   * Answer a request the agent is blocked on. `fs/*` is served here because the
   * capability was claimed at initialize; anything unrecognised is refused
   * rather than left hanging, which would stall the turn silently.
   */
  const handleRequest = useCallback(
    async (request: AcpServerRequest) => {
      const id = processRef.current;
      if (id === null) return;
      const params = (request.params ?? {}) as JsonObject;

      if (request.method === "session/request_permission") {
        const permission = readPermission(request.id, params);
        if (!permission) {
          await acpRespond(id, request.id, permissionOutcome(null));
          return;
        }
        const auto = autoPermission(permission, accessRef.current);
        if (auto !== null) {
          if (permission.toolCallId) autoApprovedRef.current.add(permission.toolCallId);
          await acpRespond(id, request.id, permissionOutcome(auto));
          return;
        }
        permissionQueueRef.current = [...permissionQueueRef.current, permission];
        showHeadPermission();
        return;
      }

      if (request.method === "_x.ai/exit_plan_mode") {
        // Grok's plan-approval ext request. Same rule as every other blocked
        // request: answered or explicitly refused — never silence, which Grok
        // reads as a disconnected client and then leaves plan mode on.
        setPendingPlan({
          requestId: request.id,
          plan: typeof params.planContent === "string" ? params.planContent : "",
          toolUseId: typeof params.toolCallId === "string" ? params.toolCallId : "",
        });
        return;
      }

      try {
        if (request.method === "fs/read_text_file") {
          const content = await invoke<string>("read_text_file", {
            path: String(params.path ?? ""),
          });
          await acpRespond(id, request.id, { content });
          return;
        }
        if (request.method === "fs/write_text_file") {
          await invoke("write_text_file", {
            path: String(params.path ?? ""),
            contents: String(params.content ?? ""),
          });
          await acpRespond(id, request.id, {});
          return;
        }
        await acpRespond(id, request.id, null, `unsupported method ${request.method}`);
      } catch (e) {
        await acpRespond(id, request.id, null, String(e));
      }
    },
    [publish, showHeadPermission]
  );

  /** Read the effort select out of a full option set. A model switch rebuilds
   *  the set, and a model without levels drops it, which empties `efforts`. */
  const applyConfigOptions = useCallback((options: AcpConfigOption[]) => {
    const option = effortOption(options);
    effortConfigIdRef.current = option?.configId ?? null;
    setUsage((u) => ({ ...u, efforts: option?.levels ?? [], effort: option?.current }));
  }, []);

  const applyNotification = useCallback((method: string, params: Json) => {
    const update = sessionUpdateOf(method, params);
    if (!update) return;
    const usage = readUsageUpdate(update);
    if (usage) {
      setUsage((prev) => ({
        ...prev,
        contextTokens: usage.contextTokens,
        contextWindow: usage.contextWindow,
        ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      }));
    }
    if (isRecord(update) && update.sessionUpdate === "config_option_update") {
      const options = configOptionsOf(update);
      if (options) applyConfigOptions(options);
      return;
    }
    if (method !== "session/update" || replayingRef.current) return;
    // A tool that was running when the user steered belongs to the reply part
    // the steer cut off; its update must land there, not open a second card.
    for (const steer of steersRef.current) {
      const part = committedRef.current.find((m) => m.id === steer.replyId);
      if (!part || !ownsToolCall(part, update)) continue;
      const patched = applyUpdate(
        { message: part, status: "tool" },
        update as AcpSessionUpdate["update"],
        part.id,
        autoApprovedRef.current
      ).message;
      committedRef.current = committedRef.current.map((m) =>
        m.id === part.id && patched ? patched : m
      );
      return;
    }
    turnRef.current = applyUpdate(
      turnRef.current,
      update as AcpSessionUpdate["update"],
      turnRef.current.message?.id ?? messageId("a"),
      autoApprovedRef.current
    );
  }, [applyConfigOptions]);

  useEffect(() => {
    if (!enabled || !awake) return;
    let disposed = false;
    const channel = new Channel<AcpEvent>();
    channelRef.current = channel;
    let stderr = "";

    // A reattached daemon session rebuilds its transcript from the replayed
    // notifications, which carry the session id in their params — the
    // fallback for when `resume` doesn't already name it.
    const captureSessionId = (params: Json) => {
      if (sessionRef.current !== null) return;
      if (
        typeof params === "object" &&
        params !== null &&
        "sessionId" in params &&
        typeof (params as { sessionId: Json }).sessionId === "string"
      ) {
        const id = (params as { sessionId: string }).sessionId;
        sessionRef.current = id;
        issuedSessionRef.current = id;
        setLiveThreadId(id);
      }
    };

    const accountIssue = (message: string) =>
      isAgentBackend(provider) ? acpAccountIssue(provider, message) : null;

    channel.onmessage = (ev) => {
      // StrictMode's double-mount kills the first process; its exit must not
      // flip the live session to "exited".
      if (disposed) return;
      // A prompt that joined the running turn is answered with it; the turn
      // settles on the last of those replies, once.
      if ((ev.type === "turnEnded" || ev.type === "turnFailed") && steerRepliesRef.current > 0) {
        steerRepliesRef.current -= 1;
        return;
      }
      if (ev.type === "exit") steerRepliesRef.current = 0;
      if (ev.type === "turnEnded" || ev.type === "turnFailed" || ev.type === "exit") {
        setPromptOpen(false);
      }
      // Stop already committed the turn. Further chunks would reopen it as a
      // live bubble; the cancelled `session/prompt` reply just clears the flag.
      if (stoppedRef.current && turnRef.current.status === "idle") {
        if (ev.type === "turnEnded" || ev.type === "turnFailed") {
          stoppedRef.current = false;
        }
        if (ev.type !== "exit") return;
      }
      switch (ev.type) {
        case "notification": {
          captureSessionId(ev.data.params);
          applyNotification(ev.data.method, ev.data.params);
          const stop = grokTurnStop(ev.data.method, ev.data.params);
          if (stop) commitTurn(stop);
          else schedulePublish();
          break;
        }
        case "notifications": {
          let stop: string | null = null;
          for (const n of ev.data) {
            captureSessionId(n.params);
            applyNotification(n.method, n.params);
            stop = grokTurnStop(n.method, n.params) ?? stop;
          }
          if (stop) commitTurn(stop);
          else schedulePublish();
          break;
        }
        case "request":
          // A prompt reads the tool calls the updates produced, so publish first.
          publish();
          void handleRequest(ev.data);
          break;
        case "turnEnded": {
          const result = ev.data.result as { stopReason?: string } | null;
          commitTurn(stoppedRef.current ? "cancelled" : result?.stopReason ?? "end_turn");
          stoppedRef.current = false;
          break;
        }
        case "turnFailed":
          // A stop the user asked for is not a failure, whatever the agent
          // called it — leave the session idle and sendable.
          if (stoppedRef.current) {
            stoppedRef.current = false;
            commitTurn("cancelled");
            break;
          }
          // A prompt that failed (a model the account cannot reach, a provider
          // error) is not a dead session: the agent is still up and takes the
          // next turn, possibly on another model. Announce it and stay
          // writable — a process that really died arrives as `exit`, and that
          // is what parks the pane on "Session failed".
          {
            // A lost login is the one failure a retry can't fix, so it parks
            // the pane on the account notice instead, the way Codex's does.
            const issue = accountIssue(ev.data.message);
            if (issue) {
              announceIssue(issue);
              commitTurn("refusal", "error");
              break;
            }
          }
          rememberRefusal(modelRef.current, ev.data.message, usageRef.current.models);
          toast.error("Turn failed", { description: ev.data.message });
          commitTurn("refusal", "idle");
          break;
        case "stderr":
          stderr = (stderr + ev.data).slice(-STDERR_CAP);
          break;
        case "exit": {
          clearPermissions(false);
          setPendingPlan(null);
          // Nothing is left to answer a question the process died holding.
          setPendingAsk(null);
          // A turn the process died in the middle of is still over: committing
          // it stops the bubble rendering as live forever and lets its
          // checkpoint settle, which a bare status change never did.
          commitTurn("exited");
          turnRef.current = { ...turnRef.current, status: "exited" };
          publish();
          if (ev.data !== 0) {
            const lines = stderr.trim().split("\n").filter(Boolean);
            setExitReason(lines[lines.length - 1] ?? null);
          }
          break;
        }
      }
    };

    // When the daemon holds this agent its replay is the only source for the
    // rendered transcript (same rule as the Claude transport): start empty so
    // the replay rebuilds it exactly once, whatever this pane showed before.
    // An agent it doesn't hold starts fresh with nothing to replay, and
    // clearing here would wipe the history seeded from the store.
    if (persistent && heldRef.current !== false) {
      committedRef.current = [];
      turnRef.current = emptyTurn();
    }

    void (async () => {
      try {
        const spawned = await acpSpawn(
          provider,
          cwd,
          {
            command: launch?.command ?? null,
            args: launch?.args ?? [],
            env: launch?.env ?? {},
          },
          channel,
          { persistent, sessionId: emberyxSessionId }
        );
        if (disposed) {
          void (persistent ? acpDetach(spawned.id) : acpKill(spawned.id));
          return;
        }
        processRef.current = spawned.id;
        if (spawned.reattached) {
          // The process was initialized by the window that started it and
          // still holds its ACP session; the replay rebuilt the transcript
          // and the session id arrives in the replayed notifications.
          publish();
          setReady(true);
          return;
        }
        // Resuming is only offered by agents that report `loadSession`, and only
        // for an id *this provider* issued: one a previous session in this pane
        // produced, or one the session was opened on (`resumeOwned`). A foreign
        // id (say a Claude thread the pane was switched away from) is never
        // handed to `grok agent stdio`, which answers it with "session/load
        // failed: Path not found." Without the load a reopened thread showed
        // its history while the agent behind it remembered none of it.
        const canLoad =
          spawned.initialize?.agentCapabilities?.loadSession === true &&
          resume !== undefined &&
          !imported &&
          (resumeOwned || resume === issuedSessionRef.current);
        if (canLoad) replayingRef.current = true;
        // Even an id this provider issued can go stale — the agent prunes its own
        // session store, and a load failure must cost the history, not the chat.
        const session = canLoad
          ? await acpSessionLoad(spawned.id, resume, cwd, emberyxSessionId).catch(
              () => acpSessionNew(spawned.id, cwd, emberyxSessionId)
            )
          : await acpSessionNew(spawned.id, cwd, emberyxSessionId);
        if (disposed) {
          void acpKill(spawned.id);
          return;
        }
        sessionRef.current = session.sessionId;
        issuedSessionRef.current = session.sessionId;
        setLiveThreadId(session.sessionId);
        appliedModelRef.current = currentModel(session);
        modelRef.current = currentModel(session);
        const models = modelOptions(session);
        const modelId = currentModel(session);
        setUsage((u) => ({
          ...u,
          model: modelId,
          models,
          contextWindow: windowOf(modelId, models) ?? u.contextWindow,
        }));
        applyConfigOptions(session.configOptions ?? []);
        setReady(true);
      } catch (e) {
        if (disposed) return;
        setPendingAsk(null);
        // An agent with no login refuses the session itself; the account
        // notice says what to do about it, where "Session failed" would not.
        const issue = accountIssue(String(e));
        if (issue) announceIssue(issue);
        setExitReason(String(e));
        turnRef.current = { ...turnRef.current, status: "error" };
        publish();
      }
    })();

    return () => {
      disposed = true;
      setReady(false);
      setLiveThreadId(undefined);
      // The next process owes no reply for this one's prompt.
      setPromptOpen(false);
      steerRepliesRef.current = 0;
      const id = processRef.current;
      processRef.current = null;
      sessionRef.current = null;
      if (id !== null) {
        // Persistent agents are detached, never killed: the pane closing is
        // not the user asking the agent to stop.
        void (persistent ? acpDetach(id) : acpKill(id));
      }
    };
  }, [
    enabled,
    awake,
    provider,
    cwd,
    resume,
    resumeOwned,
    imported,
    launch,
    persistent,
    restartNonce,
    applyNotification,
    handleRequest,
    publish,
    schedulePublish,
    commitTurn,
    clearPermissions,
    applyConfigOptions,
    announceIssue,
  ]);

  // Reopening a thread the event log owns: the turns it recorded are the
  // history, whether or not the agent could `session/load` its own copy. The
  // whole thread is read, not just its newest page: a page is 60 rows
  // *including* tool calls, so a tool-heavy tail used to reopen to almost no
  // conversation.
  //
  // Prepended, never skipped: anything already committed was sent after the
  // pane opened, so it is strictly newer. Dropping the page because the user
  // typed first is how a reopened thread lost its whole history.
  //
  // Skipped while the daemon holds (or may hold) this agent, same as the Claude
  // transport: its replay is the single source there, and seeding the store on
  // top of it races the replay into duplicated turns.
  useEffect(() => {
    if (!enabled || !resume || held !== false) return;
    const target = `${cwd}::${resume}`;
    if (seededRef.current === target) return;
    seededRef.current = target;
    let cancelled = false;
    let landed = false;
    void loadThreadHistory(cwd, resume)
      .then((page) => {
        if (cancelled) return;
        landed = true;
        const seeded = messagesFromPage(page.rows);
        if (!seeded.length) return;
        committedRef.current = [...seeded, ...committedRef.current];
        publish();
      })
      .catch((e) => {
        if (!cancelled) seededRef.current = null;
        console.error("[emberyx] thread_history failed", e);
      });
    return () => {
      cancelled = true;
      // A read torn down before it landed (StrictMode's phantom unmount) must
      // not leave the target looking seeded.
      if (!landed && seededRef.current === target) seededRef.current = null;
    };
  }, [enabled, resume, cwd, publish, held]);

  // Pin the picked model, at open and on a mid-session switch alike. "" means
  // the agent decides, and there is no id to hand back — the agent just keeps
  // whatever it is on. A refusal leaves `usage.model` naming what actually
  // runs; retrying it every render would hammer an agent that already said no.
  // It is reported instead: the pane says which model the session is still on,
  // so the picker showing the requested one is never the only thing you see.
  useEffect(() => {
    if (!enabled || !ready || !model) return;
    if (model === appliedModelRef.current) return;
    const id = processRef.current;
    const sessionId = sessionRef.current;
    if (id === null || !sessionId) return;
    appliedModelRef.current = model;
    void acpSetModel(id, sessionId, model)
      .then(() => {
        modelRef.current = model;
        setUsage((u) => ({
          ...u,
          model,
          contextWindow: windowOf(model, u.models) ?? u.contextWindow,
          contextTokens: undefined,
        }));
        setModelError(null);
      })
      .catch((e) => setModelError(`${provider} refused ${model}: ${String(e)}`));
  }, [enabled, ready, model, provider]);

  // Apply the picked reasoning level. Levels are per model and come from the
  // live session, so a level the current model doesn't offer is left alone
  // rather than sent, and a switch to a model that does offer it applies it
  // then. "" leaves the session on its own level. A refusal is reported like a
  // refused model and not retried for the same model.
  const sessionEfforts = usage.efforts;
  const sessionEffort = usage.effort;
  const sessionModel = usage.model ?? "";
  useEffect(() => {
    if (!enabled || !ready || !effort) return;
    if (!sessionEfforts?.includes(effort) || sessionEffort === effort) return;
    const id = processRef.current;
    const sessionId = sessionRef.current;
    const configId = effortConfigIdRef.current;
    if (id === null || !sessionId || !configId) return;
    const key = `${sessionModel}|${effort}`;
    if (attemptedEffortRef.current === key) return;
    attemptedEffortRef.current = key;
    void acpSetConfigOption(id, sessionId, configId, effort)
      .then((options) => {
        if (options) applyConfigOptions(options);
        else setUsage((u) => ({ ...u, effort }));
        setEffortError(null);
      })
      .catch((e) => setEffortError(`${provider} refused ${effort} effort: ${String(e)}`));
  }, [
    enabled,
    ready,
    effort,
    sessionEfforts,
    sessionEffort,
    sessionModel,
    provider,
    applyConfigOptions,
  ]);

  const promptTurn = useCallback(
    async (
      id: number,
      sessionId: string,
      text: string,
      images?: ChatImage[]
    ) => {
      setPromptOpen(true);
      await acpPrompt(id, sessionId, text, images).catch((e) => {
        setPromptOpen(false);
        throw e;
      });
    },
    []
  );

  /** `wire` is what goes to the agent when it differs from what the
   *  transcript and the event log show — a keep-going wrap. */
  const acceptTurn = useCallback(
    (text: string, images?: ChatImage[], wire = text) => {
      const id = processRef.current;
      const sessionId = sessionRef.current;
      const channel = channelRef.current;
      const hasImages = !!images && images.length > 0;
      replayingRef.current = false;
      committedRef.current = [
        ...committedRef.current,
        {
          id: messageId("u"),
          role: "user",
          text,
          thinking: "",
          tools: [],
          streaming: false,
          images: hasImages ? images : undefined,
        },
      ];
      if (!firstMsgRef.current) firstMsgRef.current = text;
      // A new turn outlives the last stop; its ending is the agent's own.
      stoppedRef.current = false;
      turnRef.current = { message: null, status: "thinking" };
      publish();
      if (id === null || !sessionId || !channel) {
        pendingSendRef.current = { text: wire, raw: text, images };
        wake();
        return;
      }
      // Reopened history already lives under `resume`. Adopting the provider's
      // new session id would mint a second sidebar row titled from this prompt.
      const logId = resume ?? sessionId;
      if (adoptedForRef.current !== logId) {
        adoptedForRef.current = logId;
        if (!resume) {
          adoptThread(logId);
          const title = threadTitleFrom(text);
          if (title) recordTimeline(logId, "threadTitle", title);
        }
      }
      recordTimeline(logId, "userPrompt", text);
      void createCheckpoint(cwd, emberyxSessionId, text).then((point) => {
        if (!point) return;
        lastCheckpointIdRef.current = point.id;
        committedRef.current = attachCheckpoint(committedRef.current, point.id);
        publish();
      });
      void promptTurn(id, sessionId, wire, images);
    },
    [cwd, emberyxSessionId, publish, adoptThread, recordTimeline, resume, wake, promptTurn]
  );

  /**
   * Put a message into the running turn: Grok over its interject method,
   * OpenCode as a second `session/prompt`, which joins the turn rather than
   * waiting behind it. The reply streamed so far is cut off as its own part, so
   * the transcript reads in the order the agent saw things. False when there is
   * no live session to steer, or Grok was handed images it has no field for.
   */
  const steer = useCallback(
    (text: string, images: ChatImage[] | undefined, wire: string): boolean => {
      const id = processRef.current;
      const sessionId = sessionRef.current;
      const interject = interjectMethod(provider);
      const hasImages = !!images && images.length > 0;
      if (id === null || !sessionId || (interject && hasImages)) return false;
      const live = turnRef.current;
      const part = live.message ? endTurn(live, "end_turn").message : null;
      committedRef.current = [
        ...committedRef.current,
        ...(part ? [part] : []),
        {
          id: messageId("u"),
          role: "user",
          text,
          thinking: "",
          tools: [],
          streaming: false,
          images: hasImages ? images : undefined,
        },
      ];
      steersRef.current = [...steersRef.current, { replyId: part?.id ?? null, prompt: text }];
      turnRef.current = { message: null, status: live.status };
      publish();
      const undelivered = (e: Error | string) =>
        toast.error("Message not delivered", { description: String(e) });
      if (interject) {
        void acpInterject(id, interject, sessionId, wire).catch(undelivered);
      } else {
        steerRepliesRef.current += 1;
        void acpPrompt(id, sessionId, wire, images).catch((e) => {
          steerRepliesRef.current -= 1;
          undelivered(e);
        });
      }
      return true;
    },
    [provider, publish]
  );

  const send = useCallback(
    (text: string, images?: ChatImage[]) => {
      const hasImages = !!images && images.length > 0;
      if (!text.trim() && !hasImages) return;
      const wire = wrapKeepGoing(text, usageRef.current);
      if (processRef.current !== null && BUSY_STATUS.has(turnRef.current.status)) {
        // A mid-turn message steers the running turn rather than waiting for
        // it to end. Only what can't be steered waits in the queue.
        if (steer(text, images, wire)) return;
        const attachments = hasImages ? JSON.stringify(images) : undefined;
        queueRef.current.push({ queueId: null, text: wire, raw: text, images });
        setQueued((n) => n + 1);
        void promptQueue.enqueue(wire, attachments, emberyxSessionId);
        return;
      }
      acceptTurn(text, images, wire);
    },
    [acceptTurn, emberyxSessionId, promptQueue, steer, wrapKeepGoing]
  );

  // Same as Claude's: the CLI's own `/compact` command, sent as a turn. Both
  // ACP agents register it — OpenCode runs its session summarizer on it.
  const compact = useCallback(() => {
    send("/compact");
  }, [send]);

  // Drain one queued turn each time the agent goes idle. The supervisor's queue
  // pops the head — and stays paused while the agent is blocked — so this only
  // dispatches what the runtime is ready for.
  // With the queue empty, a keep-going thread continues instead.
  const keepGoingOn = isKeepGoingOn(keepGoing, usage);
  useEffect(() => {
    if (status !== "idle") {
      // Held true across idle→thinking so a Strict-Mode double invoke cannot
      // inject two continues for one idle.
      drainingRef.current = false;
      return;
    }
    if (drainingRef.current || !enabled) return;
    if (queueRef.current.length === 0) {
      if (promptOpen) return;
      const step = keepGoingIdle(usageRef.current, committedRef.current);
      // The idle was mirrored sticky-working while the flag was still on.
      if (step === "done") syncSessionStatus(turnRef.current.status);
      if (step !== "continue") return;
      drainingRef.current = true;
      acceptTurn(CONTINUE_PROMPT);
      return;
    }
    drainingRef.current = true;
    let cancelled = false;
    void promptQueue
      .runNext()
      .then((next) => {
        if (cancelled || !next) return;
        // Show what the user typed; the runtime stores the keep-going wrap.
        const raw = queueRef.current[0]?.raw ?? next.text;
        queueRef.current.shift();
        setQueued((n) => Math.max(0, n - 1));
        acceptTurn(raw, parseAttachments(next.attachments), next.text);
      })
      .catch((e) => console.error("[emberyx] queue drain failed", e))
      .finally(() => {
        drainingRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [
    status,
    enabled,
    promptOpen,
    acceptTurn,
    promptQueue,
    keepGoingOn,
    keepGoingIdle,
    syncSessionStatus,
  ]);

  // The turn that woke the pane goes on the wire as soon as the spawn lands.
  useEffect(() => {
    if (!ready) return;
    const held = pendingSendRef.current;
    if (!held) return;
    pendingSendRef.current = null;
    const id = processRef.current;
    const sessionId = sessionRef.current;
    if (id === null || !sessionId) return;
    const logId = resume ?? sessionId;
    if (adoptedForRef.current !== logId) {
      adoptedForRef.current = logId;
      if (!resume) {
        adoptThread(logId);
        const title = threadTitleFrom(held.raw);
        if (title) recordTimeline(logId, "threadTitle", title);
      }
    }
    recordTimeline(logId, "userPrompt", held.raw);
    void createCheckpoint(cwd, emberyxSessionId, held.raw).then((point) => {
      if (!point) return;
      lastCheckpointIdRef.current = point.id;
      committedRef.current = attachCheckpoint(committedRef.current, point.id);
      publish();
    });
    void promptTurn(id, sessionId, held.text, held.images);
  }, [ready, cwd, emberyxSessionId, publish, adoptThread, recordTimeline, resume, promptTurn]);

  // Name a fresh chat once its first turn settles, the way a Claude chat is
  // named: no ACP agent announces a title, so the same Haiku one-shot writes
  // one. The event log holds ACP threads, so the title is recorded there to
  // outlive the session. If Haiku can't run, the opening line stays the name.
  // A resumed thread already has one.
  useEffect(() => {
    if (!enabled || status !== "idle" || resume || titledRef.current) return;
    const first = firstMsgRef.current;
    const fallback = threadTitleFrom(first);
    if (!fallback) return;
    titledRef.current = true;
    const logId = sessionRef.current;
    void invoke<string>("generate_title", { firstMessage: first })
      .then((title) => {
        if (logId) recordTimeline(logId, "threadTitle", title);
        onTitledRef.current?.(title);
      })
      .catch((e) => {
        console.error("[emberyx] generate_title failed", e);
        onTitledRef.current?.(fallback);
      });
  }, [enabled, status, resume, recordTimeline]);

  const stop = useCallback(() => {
    stopKeepGoing();
    const id = processRef.current;
    const sessionId = sessionRef.current;
    if (id === null || !sessionId) return;
    stoppedRef.current = true;
    // Cancelling while the agent waits on a permission is the common case —
    // that is what the user is stopping. An agent blocked in its permission
    // handler never processes `session/cancel`, so answer first, then cancel.
    clearPermissions(true);
    // A plan approval blocks the same way. Refusing it keeps `answerPlan` from
    // racing the cancel with an answer a dead request-id would ignore.
    const plan = pendingPlanRef.current;
    if (plan) {
      void acpRespond(id, plan.requestId, null, "cancelled by the user");
      setPendingPlan(null);
    }
    void acpCancel(id, sessionId);
    // Settle the UI now. The agent's cancelled reply is a no-op once the
    // turn is already committed; waiting for it left the square button live
    // for the rest of the in-flight generation.
    commitTurn("cancelled");
  }, [clearPermissions, commitTurn, stopKeepGoing]);

  const restart = useCallback(() => {
    setAwake(true);
    // The prompt belongs to the process about to be killed: its request ids
    // mean nothing to the next one, which numbers its own from scratch.
    clearPermissions(false);
    setPendingPlan(null);
    setPendingAsk(null);
    setExitReason(null);
    // A fresh session has not refused anything yet, and `session/new` picks the
    // model up again on its own.
    setModelError(null);
    setEffortError(null);
    attemptedEffortRef.current = "";
    steersRef.current = [];
    appliedModelRef.current = "";
    committedRef.current = [];
    turnRef.current = emptyTurn();
    publish();
    setRestartNonce((n) => n + 1);
  }, [clearPermissions, publish]);

  /** Map the pane's three-way decision onto the options this agent offered. */
  const respond = useCallback((decision: PermissionDecision) => {
    const id = processRef.current;
    const permission = permissionQueueRef.current[0];
    if (id === null || !permission) return;
    const wanted =
      decision === "deny"
        ? ["reject_once", "reject_always"]
        : decision === "allow_always"
          ? ["allow_always", "allow_once"]
          : ["allow_once", "allow_always"];
    const option =
      wanted
        .map((kind) => permission.options.find((o) => o.kind === kind))
        .find(Boolean) ?? permission.options[0];
    permissionQueueRef.current = permissionQueueRef.current.slice(1);
    void acpRespond(id, permission.requestId, permissionOutcome(option.optionId));
    // Whatever else the agent is blocked on becomes the prompt; an empty queue
    // hands the turn back to the tool that is running.
    showHeadPermission();
  }, [showHeadPermission]);

  /** Answer the plan-approval ext request. An unknown `outcome` string reads as
   *  revise on Grok's side, which is the `changes` path — notes ride `comments`
   *  even though the first reply just tells the agent to wait for them. */
  const answerPlan = useCallback((outcome: PlanOutcome, comments: string) => {
    const id = processRef.current;
    const pending = pendingPlanRef.current;
    if (!pending) return;
    if (id !== null) {
      void acpRespond(id, pending.requestId, { outcome, comments });
    }
    setPendingPlan(null);
  }, []);

  /** Hand the user's choice back to the blocked `ask_user` call in Rust. */
  const answerAsk = useCallback((answer: string) => {
    const pending = askRef.current;
    if (!pending) return;
    setPendingAsk(null);
    void invoke("answer_ask", { id: pending.id, answer });
  }, []);

  return {
    messages,
    status,
    usage,
    ready,
    asleep: !awake,
    wake,
    // ACP agents keep no listable thread store. A fresh chat publishes the
    // session id the provider just issued so the sidebar can list it; a
    // reopened thread keeps the id it was opened with, so a restart cannot
    // register the provider's new session as a second row.
    threadId: resume ?? liveThreadId,
    send,
    compact,
    queued,
    queue: promptQueue,
    stop,
    restart,
    exitReason,
    modelError: modelError ?? effortError,
    // Rewinding a sent turn is Claude's transcript trick and ACP has no
    // equivalent, so there is never anything to pull back — which is exactly
    // what `null` means to the composer, leaving Escape to do its usual thing.
    rewind: rewindNothing,
    // ACP has no turn-aware truncation. Git restore still hangs off the
    // checkpoint; the conversation stays put, which is why the capability is off.
    revertTurn: revertNothing,
    pendingPermission,
    respond,
    pendingPlan,
    answerPlan,
    pendingAsk,
    answerAsk,
    hasMore: false,
    loadingOlder: false,
    loadOlder: loadNothing,
  };
}
