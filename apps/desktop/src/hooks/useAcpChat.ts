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
import { toast } from "sonner";
import { parseAttachments, usePromptQueue } from "@/lib/promptQueue";
import {
  cancelStreamPublish,
  scheduleStreamPublish,
  streamPublishMs,
  type StreamPublishHandle,
} from "@/lib/streamPublish";
import {
  applyUpdate,
  autoPermission,
  emptyTurn,
  endTurn,
  grokTurnStop,
  jevAllowOnce,
  permissionOutcome,
  readPermission,
  type AcpPermission,
  type AcpTurn,
} from "@/lib/acp/adapter";
import type { AcpSessionUpdate } from "@/lib/acp/protocol";
import {
  accessLevelFrom,
  loadSettings,
  type PermissionMode,
} from "@/lib/settings";
import {
  acpCancel,
  acpDetach,
  acpKill,
  acpPrompt,
  acpRespond,
  acpSessionLoad,
  acpSessionNew,
  acpSetModel,
  acpSpawn,
  currentModel,
  modelOptions,
  type AcpEvent,
  type AcpServerRequest,
} from "@/lib/acp/transport";
import { attachCheckpoint, createCheckpoint } from "@/lib/checkpoints";
import {
  jevEnabled,
  largerModel,
  scoreDiffRisk,
  skillWireText,
  withJevReview,
  type JevSkill,
  type JevTurnPrep,
} from "@/lib/jev";
import { readersOf, type SkillInfo } from "@/lib/skills";
import type { McpHarness } from "@/lib/mcp";
import { snapshotTextBlock } from "@/lib/snapshotA11y";
import { fetchThreadPage, type ProjectedMessageRow } from "@/lib/threadPage";
import { threadTitleFrom } from "@/lib/threadTitle";
import { deniedVendor, splitModelLabel } from "@/lib/modelCatalog";
import { markProviderUnavailable } from "@/lib/modelFavorites";
import { useAgentStore } from "@/lib/agentStore";
import { settleTurnCheckpoint } from "@/lib/queries";
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
          input?: unknown;
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
  /** Model to run, from the picker; "" lets the agent decide. Applied over
   *  `session/set_model` — ACP has no model parameter on `session/new`. */
  model?: string;
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

/** States where a turn is in flight, so a new message queues instead of
 *  cancelling the running turn. Matches the transports that drain on idle. */
const BUSY_STATUS = new Set<ChatStatus>([
  "thinking",
  "streaming",
  "tool",
  "awaiting_permission",
  "awaiting_answer",
]);

export function useAcpChat({
  cwd,
  emberyxSessionId,
  provider,
  resume,
  model,
  launch,
  skipPermissions = false,
  permissionMode = "default",
  enabled,
  onTitled,
  visible = true,
  persistent = false,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const [ready, setReady] = useState(false);
  // Stay asleep until the user types or sends, so switching onto a fresh ACP
  // chat does not wait on spawn to paint the empty screen — unless the agent
  // is persistent, in which case it may already be running in the daemon and
  // the pane attaches right away to show it.
  const [awake, setAwake] = useState(persistent);
  const wake = useCallback(() => setAwake(true), []);
  const pendingSendRef = useRef<{ text: string; images?: ChatImage[] } | null>(
    null
  );

  // The supervisor owns this thread's prompt queue, the same runtime Claude
  // queues through — enqueue on busy, drain one per idle.
  const promptQueue = usePromptQueue(emberyxSessionId);
  const queueRef = useRef<
    { queueId: string | null; text: string; images: ChatImage[] | undefined }[]
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
          ? { queueId: p.queueId, text: p.text, images: existing.images }
          : { queueId: p.queueId, text: p.text, images: parseAttachments(p.attachments) };
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
  /** Bumped when queued permissions are dropped (stop, restart, process
   *  death) so an in-flight Jev call cannot answer a request that is gone. */
  const permissionGenRef = useRef(0);
  /** The last session id this provider handed us, which is the only id it can
   *  be asked to load back. Survives a restart of the child within this pane;
   *  nothing outside it stores an ACP session id. */
  const issuedSessionRef = useRef<string | null>(null);
  /** The model the session is actually on, so a re-render never re-sends
   *  `session/set_model` for a switch that already took. */
  const appliedModelRef = useRef("");
  /** Set while the turn ending is the user's own doing. Agents answer a
   *  cancelled `session/prompt` either way — some with `cancelled`, some with an
   *  error — and a stop the user asked for is not a failed session. */
  const stoppedRef = useRef(false);

  const setSessionStatus = useAgentStore((s) => s.setStatus);

  /** Mirror the chat's status into the store. Called from the publish path
   *  rather than an effect over `status`: an effect needs a cleanup to reset,
   *  and that cleanup ran on every thinking -> streaming -> tool step, so the
   *  store saw working -> idle -> working and restarted the run clock. Writing
   *  at the event also reaches a hidden pane, whose paints are skipped — its
   *  sidebar row used to sit on a stale status until it was shown again. */
  const mirroredStatusRef = useRef<ChatStatus | null>(null);
  const syncSessionStatus = useCallback(
    (next: ChatStatus) => {
      if (!enabled || mirroredStatusRef.current === next) return;
      mirroredStatusRef.current = next;
      setSessionStatus(emberyxSessionId, SESSION_STATUS[next]);
    },
    [enabled, emberyxSessionId, setSessionStatus]
  );

  // Idle belongs to the pane going away, which is the one thing that really is
  // a lifetime, not an event.
  useEffect(() => {
    if (!enabled) return;
    return () => setSessionStatus(emberyxSessionId, "idle");
  }, [enabled, emberyxSessionId, setSessionStatus]);

  const cancelFrame = useCallback(() => {
    cancelStreamPublish(frameRef.current);
    frameRef.current = null;
  }, []);

  const publish = useCallback(() => {
    cancelFrame();
    syncSessionStatus(turnRef.current.status);
    if (!visibleRef.current) {
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
  }, [cancelFrame, syncSessionStatus]);

  const schedulePublish = useCallback(() => {
    // Ahead of the paint, and ahead of `publish`'s own hidden-pane bail.
    syncSessionStatus(turnRef.current.status);
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
  }, [publish, syncSessionStatus]);

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
      permissionGenRef.current += 1;
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
      }).catch(() => {});
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
      if (logId && ended.message) {
        for (const tool of ended.message.tools) {
          recordTimeline(
            logId,
            "toolInvocation",
            JSON.stringify({
              name: tool.name,
              input: tool.input ?? null,
              result: tool.result ?? null,
              isError: tool.isError ?? false,
            })
          );
        }
        if (ended.message.text.trim()) {
          recordTimeline(logId, "assistantResponse", ended.message.text);
        }
      }
      if (logId) {
        recordTimeline(
          logId,
          ended.status === "error" ? "error" : "completion",
          JSON.stringify({ stopReason: ended.status === "error" ? reason : ended.status })
        );
      }
      // Freeze this turn's file delta at its settle, so edits made between
      // turns land in no turn's card. Best-effort.
      const settledId = lastCheckpointIdRef.current;
      if (settledId) {
        void (async () => {
          await settleTurnCheckpoint(cwd, settledId);
          if (!(await scoreDiffRisk(cwd, emberyxSessionId, settledId))) return;
          committedRef.current = withJevReview(committedRef.current, settledId);
          publish();
        })();
      }
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
      const params = (request.params ?? {}) as Record<string, unknown>;

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
        const once = jevAllowOnce(permission);
        if (once && loadSettings().jevAutoApprove) {
          const gen = permissionGenRef.current;
          let judged: string | null = null;
          try {
            judged = await invoke<string | null>("typesafe_judge", {
              title: permission.title,
              description: permission.description ?? null,
              toolKind: permission.toolKind ?? null,
              allowOnceId: once,
            });
          } catch {
            // Fail open to the prompt — a down TypeSafe must not stall the turn.
          }
          if (permissionGenRef.current !== gen) {
            // Stop/restart dropped this request while Jev was in flight.
            // An agent blocked in its permission handler never reads cancel,
            // so answer it rather than leave it on the wire.
            if (processRef.current === id) {
              await acpRespond(id, request.id, permissionOutcome(null));
            }
            return;
          }
          if (processRef.current !== id) return;
          if (judged) {
            if (permission.toolCallId) autoApprovedRef.current.add(permission.toolCallId);
            await acpRespond(id, request.id, permissionOutcome(judged));
            return;
          }
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

  const applyNotification = useCallback((method: string, params: unknown) => {
    if (method !== "session/update") return;
    const payload = params as AcpSessionUpdate;
    if (!payload?.update) return;
    turnRef.current = applyUpdate(
      turnRef.current,
      payload.update,
      turnRef.current.message?.id ?? messageId("a"),
      autoApprovedRef.current
    );
  }, []);

  useEffect(() => {
    if (!enabled || !awake) return;
    let disposed = false;
    const channel = new Channel<AcpEvent>();
    channelRef.current = channel;
    let stderr = "";

    // A reattached daemon session rebuilds its transcript from the replayed
    // notifications, which carry the session id in their params — the
    // fallback for when `resume` doesn't already name it.
    const captureSessionId = (params: unknown) => {
      if (sessionRef.current !== null) return;
      if (
        typeof params === "object" &&
        params !== null &&
        "sessionId" in params &&
        typeof (params as { sessionId: unknown }).sessionId === "string"
      ) {
        const id = (params as { sessionId: string }).sessionId;
        sessionRef.current = id;
        issuedSessionRef.current = id;
        setLiveThreadId(id);
      }
    };

    channel.onmessage = (ev) => {
      // StrictMode's double-mount kills the first process; its exit must not
      // flip the live session to "exited".
      if (disposed) return;
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

    // In persistent mode the daemon's replay is the only source for the
    // rendered transcript (same rule as the Claude transport): start empty so
    // the replay rebuilds it exactly once, whatever this pane showed before.
    if (persistent) {
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
        // for an id *this provider* issued — a load is attempted only when a
        // previous session in this pane produced the id, so a foreign id (say a
        // Claude thread the pane was switched away from) is never handed to
        // `grok agent stdio`, which would fail the whole spawn with
        // "session/load failed: Path not found." rather than opening a chat.
        // The id the hook publishes for the sidebar is not resume credit: it
        // crosses remounts via the persisted session, and `issuedSessionRef`
        // starts empty every mount, so only this pane's own id can match.
        const canLoad =
          spawned.initialize?.agentCapabilities?.loadSession === true &&
          resume !== undefined &&
          resume === issuedSessionRef.current;
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
        setUsage((u) => ({
          ...u,
          model: currentModel(session),
          models: modelOptions(session),
        }));
        setReady(true);
      } catch (e) {
        if (disposed) return;
        setExitReason(String(e));
        turnRef.current = { ...turnRef.current, status: "error" };
        publish();
      }
    })();

    return () => {
      disposed = true;
      setReady(false);
      setLiveThreadId(undefined);
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
    launch,
    persistent,
    restartNonce,
    applyNotification,
    handleRequest,
    publish,
    schedulePublish,
    commitTurn,
    clearPermissions,
  ]);

  // Reopening a thread the event log owns: the turns it recorded are the
  // history. The agent behind the pane starts fresh — the provider's session
  // died with its process — but the conversation itself is not lost. A first
  // page (the tail) is what the pane paints; the user's own first message
  // beats a late-arriving page, so a seed is skipped if anything is committed.
  useEffect(() => {
    if (!enabled || !resume) return;
    let cancelled = false;
    void fetchThreadPage(cwd, resume, { fresh: false })
      .then((page) => {
        if (cancelled || committedRef.current.length > 0) return;
        const seeded = messagesFromPage(page.rows);
        if (!seeded.length) return;
        committedRef.current = seeded;
        publish();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, resume, cwd, publish]);

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
        setUsage((u) => ({ ...u, model }));
        setModelError(null);
      })
      .catch((e) => setModelError(`${provider} refused ${model}: ${String(e)}`));
  }, [enabled, ready, model, provider]);

  const promptTurn = useCallback(
    async (
      id: number,
      sessionId: string,
      text: string,
      images?: ChatImage[]
    ) => {
      let wire = text;
      let notes = (images ?? []).map((img) =>
        img.snapshot ? snapshotTextBlock(img.snapshot) : ""
      );
      if (jevEnabled()) {
        try {
          const harness: McpHarness | null =
            provider === "grok" || provider === "opencode" ? provider : null;
          const listed = harness
            ? ((await invoke<SkillInfo[]>("skills_list")) ?? [])
            : [];
          const skills: JevSkill[] = listed
            .filter((skill) => harness && readersOf(skill).includes(harness))
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
            }));
          const prep = await invoke<JevTurnPrep | null>("typesafe_turn_prep", {
            prompt: text,
            skills,
            snapshot: notes.filter(Boolean).join("\n") || null,
          });
          if (prep) {
            wire = skillWireText(text, prep.skill);
            if (prep.injection) notes = notes.map(() => "");
            // A pick in the chip is a pin. Cascade only when the agent is
            // still on its own default (`model` === ""), so a DeepSeek Flash
            // the user chose is not swapped for a "larger" sibling.
            const bump =
              !model && prep.depth != null && prep.depth >= 1.5
                ? largerModel(modelRef.current, usageRef.current.models ?? [])
                : null;
            if (bump) {
              await acpSetModel(id, sessionId, bump);
              modelRef.current = bump;
              setUsage((u) => ({ ...u, model: bump }));
            }
          }
        } catch {
          // Fail-open: send the user's text as typed.
        }
      }
      await acpPrompt(id, sessionId, wire, images, notes);
    },
    [provider, model]
  );

  const acceptTurn = useCallback(
    (text: string, images?: ChatImage[]) => {
      const id = processRef.current;
      const sessionId = sessionRef.current;
      const channel = channelRef.current;
      const hasImages = !!images && images.length > 0;
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
        pendingSendRef.current = { text, images };
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
      void promptTurn(id, sessionId, text, images);
    },
    [cwd, emberyxSessionId, publish, adoptThread, recordTimeline, resume, wake, promptTurn]
  );

  const send = useCallback(
    (text: string, images?: ChatImage[]) => {
      const hasImages = !!images && images.length > 0;
      if (!text.trim() && !hasImages) return;
      if (processRef.current !== null && BUSY_STATUS.has(turnRef.current.status)) {
        // Queue like every transport: a mid-turn message waits for the idle
        // instead of cancelling the running turn, and joins the transcript on
        // delivery.
        const attachments = hasImages ? JSON.stringify(images) : undefined;
        queueRef.current.push({ queueId: null, text, images });
        setQueued((n) => n + 1);
        void promptQueue.enqueue(text, attachments, emberyxSessionId);
        return;
      }
      acceptTurn(text, images);
    },
    [acceptTurn, emberyxSessionId, promptQueue]
  );

  // Drain one queued turn each time the agent goes idle. The supervisor's queue
  // pops the head — and stays paused while the agent is blocked — so this only
  // dispatches what the runtime is ready for.
  useEffect(() => {
    if (status !== "idle") {
      drainingRef.current = false;
      return;
    }
    if (drainingRef.current) return;
    if (queueRef.current.length === 0) return;
    drainingRef.current = true;
    let cancelled = false;
    void promptQueue
      .runNext()
      .then((next) => {
        if (cancelled || !next) return;
        queueRef.current.shift();
        setQueued((n) => Math.max(0, n - 1));
        acceptTurn(next.text, parseAttachments(next.attachments));
      })
      .catch((e) => console.error("[emberyx] queue drain failed", e))
      .finally(() => {
        drainingRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [status, acceptTurn, promptQueue]);

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
        const title = threadTitleFrom(held.text);
        if (title) recordTimeline(logId, "threadTitle", title);
      }
    }
    recordTimeline(logId, "userPrompt", held.text);
    void createCheckpoint(cwd, emberyxSessionId, held.text).then((point) => {
      if (!point) return;
      lastCheckpointIdRef.current = point.id;
      committedRef.current = attachCheckpoint(committedRef.current, point.id);
      publish();
    });
    void promptTurn(id, sessionId, held.text, held.images);
  }, [ready, cwd, emberyxSessionId, publish, adoptThread, recordTimeline, resume, promptTurn]);

  // Name a fresh chat once its first turn settles. No ACP agent announces a
  // title, so the name is derived here rather than awaited — without it the
  // sidebar row keeps its first-message placeholder for the thread's whole
  // life. A resumed thread already has one.
  useEffect(() => {
    if (!enabled || status !== "idle" || resume || titledRef.current) return;
    const title = threadTitleFrom(firstMsgRef.current);
    if (!title) return;
    titledRef.current = true;
    onTitledRef.current?.(title);
  }, [enabled, status, resume]);

  const stop = useCallback(() => {
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
  }, [clearPermissions, commitTurn]);

  const restart = useCallback(() => {
    setAwake(true);
    // The prompt belongs to the process about to be killed: its request ids
    // mean nothing to the next one, which numbers its own from scratch.
    clearPermissions(false);
    setPendingPlan(null);
    setExitReason(null);
    // A fresh session has not refused anything yet, and `session/new` picks the
    // model up again on its own.
    setModelError(null);
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
    compact: noop,
    queued,
    queue: promptQueue,
    stop,
    restart,
    exitReason,
    modelError,
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
    // ACP has no `ask_user`: that is an Emberyx MCP tool wired for Claude. The
    // pane only calls this while a question is showing, and none ever is.
    pendingAsk: null as PendingAsk | null,
    answerAsk: noop,
    hasMore: false,
    loadingOlder: false,
    loadOlder: loadNothing,
  };
}

// Module-level, so the pane sees the same function every render. Inline, each
// publish handed ChatPane a new `revertTurn`, which rebuilt its `chat` object
// and re-rendered every visible turn about eight times a second.
const noop = () => {};
const rewindNothing = () => null;
const revertNothing = async () => {};
const loadNothing = async () => false;
