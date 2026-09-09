/**
 * Drives one ACP agent process (OpenCode, Grok, Cursor) and exposes the same rendered
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
 *     `turnEnded` event rather than as the result of sending.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
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
  permissionOutcome,
  readPermission,
  type AcpPermission,
  type AcpTurn,
} from "@/lib/acp/adapter";
import type { AcpSessionUpdate } from "@/lib/acp/protocol";
import { accessLevelFrom, type PermissionMode } from "@/lib/settings";
import {
  acpCancel,
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
import { useAgentStore } from "@/lib/agentStore";
import { settleTurnCheckpoint } from "@/lib/queries";
import {
  SESSION_STATUS,
  type ChatMessage,
  type ChatStatus,
  type ChatUsage,
  type PendingAsk,
  type PendingPermission,
  type PermissionDecision,
} from "@/hooks/useAgentChat";

/** Keep the tail of stderr for an exit message; the rest is diagnostics. */
const STDERR_CAP = 4000;

interface Options {
  cwd: string;
  emberyxSessionId: string;
  /** Provider id — the ACP binary to drive (`opencode`, `grok`, `cursor`). */
  provider: string;
  /** ACP session id to resume; omit to open a fresh one. */
  resume?: string;
  /** Model to run, from the picker; "" lets the agent decide. Applied over
   *  `session/set_model` — ACP has no model parameter on `session/new`. */
  model?: string;
  /** Binary override + extra args from Settings → Providers. Identity-stable
   *  at the call site — it rides the spawn effect's deps. */
  launch?: { command: string | null; args: string[]; env?: Record<string, string> };
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

let nextMessageId = 0;
const messageId = (prefix: string) => `acp-${prefix}-${(nextMessageId += 1)}`;

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
  visible = true,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const [ready, setReady] = useState(false);
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);
  /** Set when the agent refused a model switch. The picker would otherwise go on
   *  showing the model you asked for while the session runs another one. */
  const [modelError, setModelError] = useState<string | null>(null);

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

  /** Fold the streamed turn into the committed transcript. */
  const commitTurn = useCallback(
    (reason: string) => {
      const ended = endTurn(turnRef.current, reason);
      if (ended.message) committedRef.current = [...committedRef.current, ended.message];
      turnRef.current = { message: null, status: ended.status };
      // The rows carry the flag themselves once committed, so the ids are dead
      // weight past the turn that approved them.
      autoApprovedRef.current.clear();
      publish();
      // Freeze this turn's file delta at its settle, so edits made between
      // turns land in no turn's card. Best-effort.
      const settledId = lastCheckpointIdRef.current;
      if (settledId) void settleTurnCheckpoint(cwd, settledId);
    },
    [publish, cwd]
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
        permissionQueueRef.current = [...permissionQueueRef.current, permission];
        showHeadPermission();
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
    if (!enabled) return;
    let disposed = false;
    const channel = new Channel<AcpEvent>();
    channelRef.current = channel;
    let stderr = "";

    channel.onmessage = (ev) => {
      // StrictMode's double-mount kills the first process; its exit must not
      // flip the live session to "exited".
      if (disposed) return;
      switch (ev.type) {
        case "notification":
          applyNotification(ev.data.method, ev.data.params);
          schedulePublish();
          break;
        case "notifications":
          for (const n of ev.data) applyNotification(n.method, n.params);
          schedulePublish();
          break;
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
          setExitReason(ev.data.message);
          commitTurn("refusal");
          break;
        case "stderr":
          stderr = (stderr + ev.data).slice(-STDERR_CAP);
          break;
        case "exit": {
          clearPermissions(false);
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
          channel
        );
        if (disposed) {
          void acpKill(spawned.id);
          return;
        }
        processRef.current = spawned.id;
        // Resuming is only offered by agents that report `loadSession`, and only
        // for an id *this provider* issued. Session ids are per-provider, and
        // this hook publishes none (`threadId` below is undefined), so the id on
        // an ACP session can only have come from the Claude or Codex thread it
        // was switched away from — handing that to `grok agent stdio` fails the
        // whole spawn with "session/load failed: Path not found." rather than
        // opening a chat. A load is attempted only when a previous session in
        // this pane produced the id.
        const canLoad =
          spawned.initialize?.agentCapabilities?.loadSession === true &&
          resume !== undefined &&
          resume === issuedSessionRef.current;
        // Even an id this provider issued can go stale — the agent prunes its own
        // session store, and a load failure must cost the history, not the chat.
        const session = canLoad
          ? await acpSessionLoad(spawned.id, resume, cwd).catch(() =>
              acpSessionNew(spawned.id, cwd)
            )
          : await acpSessionNew(spawned.id, cwd);
        if (disposed) {
          void acpKill(spawned.id);
          return;
        }
        sessionRef.current = session.sessionId;
        issuedSessionRef.current = session.sessionId;
        appliedModelRef.current = currentModel(session);
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
      const id = processRef.current;
      processRef.current = null;
      sessionRef.current = null;
      if (id !== null) void acpKill(id);
    };
  }, [
    enabled,
    provider,
    cwd,
    resume,
    launch,
    restartNonce,
    applyNotification,
    handleRequest,
    publish,
    schedulePublish,
    commitTurn,
    clearPermissions,
  ]);

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
        setUsage((u) => ({ ...u, model }));
        setModelError(null);
      })
      .catch((e) => setModelError(`${provider} refused ${model}: ${String(e)}`));
  }, [enabled, ready, model, provider]);

  const send = useCallback(
    (text: string) => {
      const id = processRef.current;
      const sessionId = sessionRef.current;
      const channel = channelRef.current;
      if (id === null || !sessionId || !channel || !text.trim()) return;
      committedRef.current = [
        ...committedRef.current,
        {
          id: messageId("u"),
          role: "user",
          text,
          thinking: "",
          tools: [],
          streaming: false,
        },
      ];
      // A new turn outlives the last stop; its ending is the agent's own.
      stoppedRef.current = false;
      turnRef.current = { message: null, status: "thinking" };
      publish();
      void createCheckpoint(cwd, emberyxSessionId, text).then((point) => {
        if (!point) return;
        lastCheckpointIdRef.current = point.id;
        committedRef.current = attachCheckpoint(committedRef.current, point.id);
        publish();
      });
      void acpPrompt(id, sessionId, text, channel);
    },
    [cwd, emberyxSessionId, publish]
  );

  const stop = useCallback(() => {
    const id = processRef.current;
    const sessionId = sessionRef.current;
    if (id === null || !sessionId) return;
    stoppedRef.current = true;
    // Cancelling while the agent waits on a permission is the common case —
    // that is what the user is stopping. An agent blocked in its permission
    // handler never processes `session/cancel`, so answer first, then cancel.
    clearPermissions(true);
    void acpCancel(id, sessionId);
  }, [clearPermissions]);

  const restart = useCallback(() => {
    // The prompt belongs to the process about to be killed: its request ids
    // mean nothing to the next one, which numbers its own from scratch.
    clearPermissions(false);
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

  return {
    messages,
    status,
    usage,
    ready,
    // ACP sessions have nothing to resume, so the pane never opens one it isn't
    // about to use — the process starts on mount and `wake` is already true.
    asleep: false,
    wake: () => {},
    // ACP agents keep no listable thread store, so there is no id the sidebar
    // could resume — see `capabilitiesOf(...).threads`.
    threadId: undefined as string | undefined,
    send,
    compact: () => {},
    queued: 0,
    // ACP has no queue of its own; a turn is cancelled and re-sent instead.
    queue: null,
    stop,
    restart,
    exitReason,
    modelError,
    // Rewinding a sent turn is Claude's transcript trick and ACP has no
    // equivalent, so there is never anything to pull back — which is exactly
    // what `null` means to the composer, leaving Escape to do its usual thing.
    rewind: () => null,
    // ACP has no turn-aware truncation. Git restore still hangs off the
    // checkpoint; the conversation stays put, which is why the capability is off.
    revertTurn: async () => {},
    pendingPermission,
    respond,
    // ACP has no `ask_user`: that is an Emberyx MCP tool wired for Claude. The
    // pane only calls this while a question is showing, and none ever is.
    pendingAsk: null as PendingAsk | null,
    answerAsk: () => {},
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => false,
  };
}
