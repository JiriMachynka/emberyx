/**
 * Drives one `codex app-server` process and exposes the same rendered chat
 * model `useAgentChat` does, so the pane consumes either without branching.
 *
 * Everything about *what a frame means* lives in `lib/codex/adapter`; this hook
 * owns the process, the channel, the pending server requests and React state.
 * Adapter state is held in a ref and published to React at most once per
 * animation frame, so a streaming turn re-renders the pane per frame, not per
 * token.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  APPROVAL_METHODS,
  ASK_METHODS,
  applyCodexNotification,
  approvalResult,
  askFromRequest,
  askResult,
  initialCodexState,
  permissionFromRequest,
  type CodexAsk,
  type CodexChatState,
  type CodexServerRequest,
  type CodexSubagentEvent,
} from "@/lib/codex/adapter";
import { decodeThreadStart, isRecord } from "@/lib/codex/decode";
import {
  codexKill,
  codexRespond,
  codexSetThreadName,
  codexSpawn,
  codexThreadCompact,
  codexThreadResume,
  codexThreadStart,
  codexTurnInterrupt,
  codexTurnSteer,
  codexTurnStart,
  generateCodexTitle,
  type CodexEvent,
} from "@/lib/codex/transport";
import { classifyFailure } from "@/lib/accountState";
import { useAgentStore } from "@/lib/agentStore";
import { registerAgent, setAgentLifecycle } from "@/lib/agentRegistry";
import { nextChangeId } from "@/lib/changes";
import {
  SESSION_STATUS,
  type ChatImage,
  type ChatMessage,
  type ChatStatus,
  type ChatUsage,
  type PendingAsk,
  type PendingPermission,
  type PermissionDecision,
} from "@/hooks/useAgentChat";

interface Options {
  cwd: string;
  emberyxSessionId: string;
  /** Codex thread id to resume; omit to start a fresh thread. */
  resume?: string;
  /** Grant every approval up front and drop the sandbox. */
  skipPermissions?: boolean;
  /** `model` override; "" lets the CLI pick. Changing it respawns. */
  model?: string;
  /** Reasoning effort for each turn; "" lets the CLI pick. It rides
   *  `turn/start`, so changing it never respawns. */
  effort?: string;
  /** Binary override + extra args from Settings → Providers. Identity-stable
   *  at the call site — it rides the spawn effect's deps. */
  launch?: { command: string | null; args: string[] };
  /** Sandbox posture for the thread; "" derives it from `skipPermissions`.
   *  Thread-scoped, so changing it respawns. */
  codexSandbox?: string;
  /** Called once with the title generated for a fresh thread. */
  onTitled?: (title: string) => void;
  /** False while a session of another backend owns this pane — the hook still
   *  runs (rules of hooks) but spawns nothing. */
  enabled?: boolean;
}

/** States where a turn is in flight, so a new message steers it. */
const BUSY_STATUS = new Set<ChatStatus>([
  "thinking",
  "streaming",
  "tool",
  "awaiting_permission",
  "awaiting_answer",
  "retrying",
]);

/** Rolling stderr kept per spawn, enough to classify a failure. */
const STDERR_CAP = 8192;

let counter = 0;
const localId = () => `codex-m${++counter}`;

/** The approval posture a spawn asks for. A sandbox from settings overrides
 *  the derived one; the approval policy stays posture-driven. */
const approvalFor = (skipPermissions: boolean, sandbox: string) => ({
  approvalPolicy: skipPermissions ? "never" : "on-request",
  sandbox:
    sandbox || (skipPermissions ? "danger-full-access" : "workspace-write"),
});

const userText = (content: unknown): string =>
  (Array.isArray(content) ? content : [])
    .flatMap((c) =>
      isRecord(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : []
    )
    .join("");

/**
 * Rebuild a resumed thread's transcript by replaying its stored turns through
 * the same adapter the live stream uses. User messages are inserted directly:
 * the adapter ignores them on the wire, because the pane has already drawn the
 * message it just sent.
 */
export function replayThread(state: CodexChatState, thread: unknown): CodexChatState {
  if (!isRecord(thread) || !Array.isArray(thread.turns)) return state;
  let next = state;
  for (const turn of thread.turns) {
    if (!isRecord(turn) || typeof turn.id !== "string") continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const asked = items.filter(
      (i): i is Record<string, unknown> => isRecord(i) && i.type === "userMessage"
    );
    const messages = asked.flatMap((i) => {
      const text = userText(i.content);
      if (!text) return [];
      return [
        {
          id: localId(),
          role: "user" as const,
          text,
          thinking: "",
          tools: [],
          streaming: false,
        },
      ];
    });
    next = { ...next, messages: [...next.messages, ...messages] };
    next = applyCodexNotification(next, "turn/started", { turn: { id: turn.id } }).state;
    for (const item of items) {
      if (isRecord(item) && item.type === "userMessage") continue;
      next = applyCodexNotification(next, "item/completed", { item }).state;
    }
    next = applyCodexNotification(next, "turn/completed", {
      turn: { id: turn.id, status: turn.status },
    }).state;
  }
  return next;
}

export function useCodexChat({
  cwd,
  emberyxSessionId,
  resume,
  skipPermissions = false,
  model = "",
  effort = "",
  launch,
  codexSandbox = "",
  onTitled,
  enabled = true,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const [ready, setReady] = useState(false);
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(
    null
  );
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  // Bumped by `restart` to re-run the spawn effect for the same target.
  const [attempt, setAttempt] = useState(0);

  // The whole chat model lives here and is published on a frame boundary; React
  // state is a snapshot of it, never the source of truth.
  const stateRef = useRef<CodexChatState>(initialCodexState());
  const idRef = useRef<number | null>(null);
  const threadRef = useRef<string | undefined>(resume);
  // The app-server's own thread id, published so the pane can register the
  // thread with the sidebar as soon as it exists.
  const [liveThreadId, setLiveThreadId] = useState<string | undefined>(resume);
  // The server->client request each prompt was built from, kept so the answer
  // can be routed back to the right JSON-RPC id.
  const approvalRef = useRef<CodexServerRequest | null>(null);
  const askRef = useRef<CodexAsk | null>(null);
  const frameRef = useRef<number | null>(null);
  // Titling reads the opening message once, after the first turn settles.
  const titledRef = useRef(false);
  const firstMsgRef = useRef<string | null>(null);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;

  // Two app-server params on different clocks: the model opens the thread, the
  // effort rides each turn, so `send` reads it through a ref rather than
  // rebuilding (and respawning) on a change.
  const effortRef = useRef(effort);
  effortRef.current = effort;

  const addChange = useAgentStore((st) => st.addChange);
  const setSessionStatus = useAgentStore((st) => st.setStatus);
  const reportAccountIssue = useAgentStore((st) => st.reportAccountIssue);

  useEffect(() => {
    if (!enabled) return;
    setSessionStatus(emberyxSessionId, SESSION_STATUS[status]);
    void setAgentLifecycle(emberyxSessionId, status);
    return () => setSessionStatus(emberyxSessionId, "idle");
  }, [enabled, status, emberyxSessionId, setSessionStatus]);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  // Every setter bails out when the value is unchanged by identity, so an
  // untouched slice never re-renders its subscribers.
  const publish = useCallback(() => {
    cancelFrame();
    const s = stateRef.current;
    setMessages(s.messages);
    setStatus(s.status);
    setUsage(s.usage);
    setExitReason(s.errorMessage);
  }, [cancelFrame]);

  const schedulePublish = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      publish();
    });
  }, [publish]);

  // A queued frame can only render into a live component.
  useEffect(() => cancelFrame, [cancelFrame]);

  /** Move the chat to a status the transport, not the stream, decided. */
  const setLocalStatus = useCallback(
    (next: ChatStatus) => {
      stateRef.current = { ...stateRef.current, status: next };
      publish();
    },
    [publish]
  );

  const applySubagent = useCallback(
    (event: CodexSubagentEvent) => {
      const store = useAgentStore.getState();
      if (event.type === "start") {
        store.startSubagent({
          id: event.id,
          session: emberyxSessionId,
          description: event.description,
          // Codex names no agent type on the wire; the run header omits it.
          subagentType: "",
          prompt: event.prompt,
          // A spawn is always waited on in the same turn, so it never becomes
          // the kind of detached run that has to settle on idleness.
          background: false,
        });
      } else if (event.type === "activity") {
        store.addSubagentActivity(event.id, event.activity);
      } else {
        store.endSubagent(event.id, event.isError);
      }
    },
    [emberyxSessionId]
  );

  const applyNotification = useCallback(
    (method: string, params: unknown) => {
      const { state, changes, subagents, sessionStatus } = applyCodexNotification(
        stateRef.current,
        method,
        params
      );
      stateRef.current = state;
      const p = isRecord(params) ? params : null;
      const turn = p && isRecord(p.turn) ? p.turn : null;
      const eventThreadId = p && typeof p.threadId === "string" ? p.threadId : threadRef.current;
      const eventTurnId = turn && typeof turn.id === "string" ? turn.id : state.turnId;
      const isSubagentTurn = !!(eventThreadId && state.agentThreads[eventThreadId]);
      if (method === "turn/started" && eventThreadId && eventTurnId && !isSubagentTurn) {
        void invoke("agent_attach_turn", {
          agentId: emberyxSessionId,
          threadId: eventThreadId,
          turnId: eventTurnId,
        });
      } else if (
        (method === "turn/completed" || method === "turn/failed") &&
        eventThreadId &&
        eventTurnId &&
        !isSubagentTurn
      ) {
        void invoke("agent_complete_turn", {
          agentId: emberyxSessionId,
          threadId: eventThreadId,
          turnId: eventTurnId,
          status: turn && typeof turn.status === "string" ? turn.status : method,
        });
      }
      for (const c of changes) {
        addChange({
          id: nextChangeId(),
          session: emberyxSessionId,
          file: c.path,
          tool: c.tool,
          oldText: c.oldText,
          newText: c.newText,
          time: Date.now(),
        });
      }
      for (const event of subagents) applySubagent(event);
      if (sessionStatus) setSessionStatus(emberyxSessionId, sessionStatus);
    },
    [addChange, applySubagent, emberyxSessionId, setSessionStatus]
  );

  const handleRequest = useCallback(
    (req: CodexServerRequest) => {
      if (APPROVAL_METHODS.includes(req.method)) {
        const pending = permissionFromRequest(stateRef.current, req);
        if (!pending) return;
        approvalRef.current = req;
        setPendingPermission(pending);
        setLocalStatus("awaiting_permission");
        return;
      }
      if (ASK_METHODS.includes(req.method)) {
        const built = askFromRequest(req);
        if (!built) return;
        askRef.current = built.ask;
        setPendingAsk(built.pending);
        setLocalStatus("awaiting_answer");
        return;
      }
      // Everything else (client tool calls, token refresh) needs a capability
      // this client never advertised, so answering would be a guess.
      console.warn("[emberyx] unanswered codex request", req.method);
    },
    [setLocalStatus]
  );

  // Spawn one app-server per (cwd, resume, model, posture) target and open its
  // thread. `attempt` re-runs it for the same target after a restart.
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const channel = new Channel<CodexEvent>();
    let stderr = "";
    let announced = false;
    const checkStderr = () => {
      if (announced) return;
      const issue = classifyFailure(stderr, "stderr", "codex");
      if (!issue) return;
      announced = true;
      reportAccountIssue(emberyxSessionId, issue);
    };

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
          // A prompt reads the tool calls the deltas produced, so publish first.
          publish();
          handleRequest(ev.data);
          break;
        case "stderr":
          stderr = (stderr + ev.data).slice(-STDERR_CAP);
          checkStderr();
          break;
        case "warning":
          console.warn("[emberyx] codex:", ev.data);
          break;
        case "exit":
          setPendingPermission(null);
          setPendingAsk(null);
          approvalRef.current = null;
          askRef.current = null;
          setLocalStatus("exited");
          if (ev.data !== 0) {
            checkStderr();
            if (!announced) {
              const lines = stderr.trim().split("\n").filter(Boolean);
              setExitReason(lines[lines.length - 1] ?? null);
            }
          }
          break;
      }
    };

    void (async () => {
      try {
        const spawned = await codexSpawn(
          cwd,
          launch?.command ?? null,
          channel
        );
        if (disposed) {
          void codexKill(spawned.id);
          return;
        }
        idRef.current = spawned.id;
        void registerAgent(emberyxSessionId, cwd, "codex", spawned.id);
        // Prefer the live thread id so a respawn (model switch, restart) picks
        // the same thread back up instead of starting a fresh one.
        const threadId = threadRef.current ?? resume;
        const config = {
          cwd,
          model: model || null,
          ...approvalFor(skipPermissions, codexSandbox),
        };
        const opened = threadId
          ? await codexThreadResume(spawned.id, { threadId, ...config })
          : await codexThreadStart(spawned.id, config);
        if (disposed) return;
        const thread = decodeThreadStart(opened);
        if (!thread) throw new Error("codex opened no thread");
        threadRef.current = thread.threadId;
        setLiveThreadId(thread.threadId);
        void invoke("agent_attach_thread", {
          agentId: emberyxSessionId,
          threadId: thread.threadId,
        });
        if (thread.model) {
          stateRef.current = {
            ...stateRef.current,
            usage: { ...stateRef.current.usage, model: thread.model },
          };
        }
        // A resumed thread replays nothing on the wire; its turns come back on
        // the response. Only fill an empty transcript, never clobber a live one.
        if (threadId && stateRef.current.messages.length === 0) {
          const body = isRecord(opened) ? opened.thread : undefined;
          stateRef.current = replayThread(stateRef.current, body);
        }
        publish();
        setReady(true);
      } catch (e) {
        console.error("[emberyx] codex spawn failed", e);
        if (disposed) return;
        setLocalStatus("error");
        setExitReason(String(e));
      }
    })();

    return () => {
      disposed = true;
      setReady(false);
      if (idRef.current !== null) {
        void codexKill(idRef.current);
        idRef.current = null;
      }
    };
  }, [
    enabled,
    cwd,
    resume,
    // Effort rides the next turn; model, sandbox and the launch override are
    // thread-scoped, so each of those changes respawns.
    model,
    codexSandbox,
    launch,
    skipPermissions,
    emberyxSessionId,
    attempt,
    applyNotification,
    handleRequest,
    publish,
    schedulePublish,
    setLocalStatus,
    reportAccountIssue,
  ]);

  // Auto-title a fresh chat once its first turn settles. Codex names a thread
  // only when the user does, so the name is set on the thread itself and
  // `thread/list` picks it up. Resumed threads already have one.
  useEffect(() => {
    if (!enabled || status !== "idle" || resume || titledRef.current) return;
    const threadId = threadRef.current;
    const first = firstMsgRef.current;
    if (!threadId || !first) return;
    titledRef.current = true;
    void generateCodexTitle(cwd, first)
      .then(async (title) => {
        const id = idRef.current;
        if (!title || id === null) return;
        await codexSetThreadName(id, threadId, title);
        onTitledRef.current?.(title);
      })
      .catch((e) => console.error("[emberyx] codex title failed", e));
  }, [enabled, status, resume, cwd]);

  const restart = useCallback(() => {
    setPendingPermission(null);
    setPendingAsk(null);
    setExitReason(null);
    setLocalStatus("idle");
    setAttempt((n) => n + 1);
  }, [setLocalStatus]);

  /** Abort the turn in flight. The app-server survives it, so `turn/completed`
   *  settles the status rather than an exit. */
  const interrupt = useCallback(() => {
    const id = idRef.current;
    const { turnId } = stateRef.current;
    const threadId = threadRef.current;
    if (id === null || !turnId || !threadId) return;
    void codexTurnInterrupt(id, threadId, turnId).catch((e) =>
      console.error("[emberyx] codex interrupt failed", e)
    );
  }, []);

  const stop = useCallback(() => {
    publish();
    interrupt();
  }, [interrupt, publish]);

  const deliver = useCallback((text: string, images?: ChatImage[]) => {
    const id = idRef.current;
    const threadId = threadRef.current;
    if (id === null || !threadId) return;
    const input: Record<string, unknown>[] = [];
    if (text.trim()) input.push({ type: "text", text, text_elements: [] });
    for (const img of images ?? []) {
      input.push({ type: "image", url: `data:${img.mediaType};base64,${img.data}` });
    }
    const turnId = stateRef.current.turnId;
    const effort = effortRef.current;
    const call = turnId
      ? codexTurnSteer(id, { threadId, input, expectedTurnId: turnId })
      : codexTurnStart(id, { threadId, input, ...(effort ? { effort } : {}) });
    void call.catch((e) => console.error("[emberyx] codex turn failed", e));
  }, []);

  /** Accept a turn at any time. A message sent mid-turn steers the running
   *  turn, so nothing is ever queued. */
  const send = useCallback(
    (text: string, images?: ChatImage[]) => {
      const hasImages = !!images && images.length > 0;
      if (idRef.current === null || (!text.trim() && !hasImages)) return;
      if (firstMsgRef.current === null && text.trim()) firstMsgRef.current = text;
      const message: ChatMessage = {
        id: localId(),
        role: "user",
        text,
        thinking: "",
        tools: [],
        streaming: false,
        images: hasImages ? images : undefined,
      };
      const s = stateRef.current;
      stateRef.current = {
        ...s,
        messages: [...s.messages, message],
        status: BUSY_STATUS.has(s.status) ? s.status : "thinking",
        errorMessage: null,
      };
      publish();
      deliver(text, images);
    },
    [deliver, publish]
  );

  const compact = useCallback(() => {
    const id = idRef.current;
    const threadId = threadRef.current;
    if (id === null || !threadId) return;
    const s = stateRef.current;
    stateRef.current = {
      ...s,
      status: BUSY_STATUS.has(s.status) ? s.status : "thinking",
      errorMessage: null,
    };
    publish();
    void codexThreadCompact(id, { threadId }).catch((e) => {
      toast.error("Compact failed", { description: String(e) });
    });
  }, [publish]);

  /**
   * Stop the newest turn. A turn that produced nothing is un-sent: it leaves
   * the transcript and its text is handed back for the composer to restore.
   * Once the assistant has said or done something that reply is worth keeping,
   * so this degrades to a plain stop.
   */
  const rewind = useCallback((): { text: string; images?: ChatImage[] } | null => {
    const s = stateRef.current;
    if (!BUSY_STATUS.has(s.status)) return null;
    const idx = s.messages.map((m) => m.role).lastIndexOf("user");
    if (idx === -1) return null;
    const restored = { text: s.messages[idx].text, images: s.messages[idx].images };
    const draft = s.draft
      ? s.messages.find((m) => m.id === s.draft?.messageId)
      : undefined;
    const produced =
      !!draft && (!!draft.text || !!draft.thinking || draft.tools.length > 0);
    interrupt();
    if (produced) return null;
    stateRef.current = { ...s, messages: s.messages.slice(0, idx) };
    publish();
    return restored;
  }, [interrupt, publish]);

  /** Answer a pending approval. Declining doesn't end the turn — Codex reports
   *  the item as declined and the model carries on. */
  const respond = useCallback(
    (decision: PermissionDecision) => {
      const id = idRef.current;
      const req = approvalRef.current;
      if (id === null || req === null) return;
      const requested = isRecord(req.params) ? req.params.permissions : undefined;
      void codexRespond(
        id,
        req.id,
        approvalResult(req.method, decision, requested)
      ).catch((e) => console.error("[emberyx] codex respond failed", e));
      approvalRef.current = null;
      setPendingPermission(null);
      setLocalStatus("thinking");
    },
    [setLocalStatus]
  );

  /** Hand a choice back to the blocked question. */
  const answerAsk = useCallback(
    (answer: string) => {
      const id = idRef.current;
      const ask = askRef.current;
      if (id === null || ask === null) return;
      void codexRespond(id, ask.requestId, askResult(ask, answer)).catch((e) =>
        console.error("[emberyx] codex answer failed", e)
      );
      askRef.current = null;
      setPendingAsk(null);
      setLocalStatus("thinking");
    },
    [setLocalStatus]
  );

  return {
    messages,
    status,
    usage,
    ready,
    threadId: liveThreadId,
    send,
    compact,
    queued: 0,
    // Codex steers instead of queueing, so it has no runtime queue to manage.
    queue: null,
    stop,
    restart,
    exitReason,
    rewind,
    pendingPermission,
    respond,
    pendingAsk,
    answerAsk,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => false,
  };
}
