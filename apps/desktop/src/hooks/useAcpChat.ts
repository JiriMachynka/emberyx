/**
 * Drives one ACP agent process (OpenCode today) and exposes the same rendered
 * chat model `useAgentChat` does, so the pane consumes any backend without
 * branching.
 *
 * Everything about *what a frame means* lives in `lib/acp/adapter`; this hook
 * owns the process, the channel, the agent's blocked requests, and React state.
 * Turn state is held in a ref and published at most once per animation frame,
 * so a streaming turn re-renders the pane per frame, not per token.
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
  applyUpdate,
  emptyTurn,
  endTurn,
  permissionOutcome,
  readPermission,
  type AcpPermission,
  type AcpTurn,
} from "@/lib/acp/adapter";
import type { AcpSessionUpdate } from "@/lib/acp/protocol";
import {
  acpCancel,
  acpKill,
  acpPrompt,
  acpRespond,
  acpSessionLoad,
  acpSessionNew,
  acpSpawn,
  currentModel,
  type AcpEvent,
  type AcpServerRequest,
} from "@/lib/acp/transport";
import { useAgentStore } from "@/lib/agentStore";
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
  /** Provider id — the ACP binary to drive (`opencode`, `grok`, `kilo`). */
  provider: string;
  /** ACP session id to resume; omit to open a fresh one. */
  resume?: string;
  enabled: boolean;
  onTitled?: (title: string) => void;
}

let nextMessageId = 0;
const messageId = (prefix: string) => `acp-${prefix}-${(nextMessageId += 1)}`;

export function useAcpChat({
  cwd,
  emberyxSessionId,
  provider,
  resume,
  enabled,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const [ready, setReady] = useState(false);
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const [restartNonce, setRestartNonce] = useState(0);

  // Committed turns, plus the one being streamed. Held in refs so a token
  // doesn't have to round-trip through React to be folded in.
  const committedRef = useRef<ChatMessage[]>([]);
  const turnRef = useRef<AcpTurn>(emptyTurn());
  const frameRef = useRef<number | null>(null);
  const processRef = useRef<number | null>(null);
  const sessionRef = useRef<string | null>(null);
  const channelRef = useRef<Channel<AcpEvent> | null>(null);
  /** The agent request a permission prompt is answering, kept for the reply. */
  const permissionRef = useRef<AcpPermission | null>(null);

  const setSessionStatus = useAgentStore((s) => s.setStatus);

  useEffect(() => {
    if (!enabled) return;
    setSessionStatus(emberyxSessionId, SESSION_STATUS[status]);
    return () => setSessionStatus(emberyxSessionId, "idle");
  }, [enabled, status, emberyxSessionId, setSessionStatus]);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const publish = useCallback(() => {
    cancelFrame();
    const turn = turnRef.current;
    setMessages(
      turn.message ? [...committedRef.current, turn.message] : committedRef.current
    );
    setStatus(turn.status);
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

  /** Fold the streamed turn into the committed transcript. */
  const commitTurn = useCallback(
    (reason: string) => {
      const ended = endTurn(turnRef.current, reason);
      if (ended.message) committedRef.current = [...committedRef.current, ended.message];
      turnRef.current = { message: null, status: ended.status };
      publish();
    },
    [publish]
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
        permissionRef.current = permission;
        setPendingPermission({
          requestId: String(permission.requestId),
          toolName: permission.title,
          input: permission.description ?? {},
          suggestions: [],
          toolUseId: permission.toolCallId ?? "",
        });
        turnRef.current = { ...turnRef.current, status: "awaiting_permission" };
        publish();
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
    [publish]
  );

  const applyNotification = useCallback((method: string, params: unknown) => {
    if (method !== "session/update") return;
    const payload = params as AcpSessionUpdate;
    if (!payload?.update) return;
    turnRef.current = applyUpdate(
      turnRef.current,
      payload.update,
      turnRef.current.message?.id ?? messageId("a")
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
          commitTurn(result?.stopReason ?? "end_turn");
          break;
        }
        case "turnFailed":
          setExitReason(ev.data.message);
          commitTurn("refusal");
          break;
        case "stderr":
          stderr = (stderr + ev.data).slice(-STDERR_CAP);
          break;
        case "exit": {
          setPendingPermission(null);
          permissionRef.current = null;
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
        const spawned = await acpSpawn(provider, cwd, channel);
        if (disposed) {
          void acpKill(spawned.id);
          return;
        }
        processRef.current = spawned.id;
        // Resuming is only offered by agents that report `loadSession`; asking
        // one that doesn't would fail the whole spawn rather than start a chat.
        const canLoad = spawned.initialize?.agentCapabilities?.loadSession === true;
        const session =
          resume && canLoad
            ? await acpSessionLoad(spawned.id, resume, cwd)
            : await acpSessionNew(spawned.id, cwd);
        if (disposed) {
          void acpKill(spawned.id);
          return;
        }
        sessionRef.current = session.sessionId;
        setUsage((u) => ({ ...u, model: currentModel(session) }));
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
    restartNonce,
    applyNotification,
    handleRequest,
    publish,
    schedulePublish,
    commitTurn,
  ]);

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
      turnRef.current = { message: null, status: "thinking" };
      publish();
      void acpPrompt(id, sessionId, text, channel);
    },
    [publish]
  );

  const stop = useCallback(() => {
    const id = processRef.current;
    const sessionId = sessionRef.current;
    if (id === null || !sessionId) return;
    void acpCancel(id, sessionId);
  }, []);

  const restart = useCallback(() => {
    setExitReason(null);
    committedRef.current = [];
    turnRef.current = emptyTurn();
    publish();
    setRestartNonce((n) => n + 1);
  }, [publish]);

  /** Map the pane's three-way decision onto the options this agent offered. */
  const respond = useCallback((decision: PermissionDecision) => {
    const id = processRef.current;
    const permission = permissionRef.current;
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
    setPendingPermission(null);
    permissionRef.current = null;
    turnRef.current = { ...turnRef.current, status: "tool" };
    publish();
    void acpRespond(id, permission.requestId, permissionOutcome(option.optionId));
  }, [publish]);

  return {
    messages,
    status,
    usage,
    ready,
    send,
    queued: 0,
    // ACP has no queue of its own; a turn is cancelled and re-sent instead.
    queue: null,
    stop,
    restart,
    exitReason,
    // Rewinding a sent turn is Claude's transcript trick and ACP has no
    // equivalent, so there is never anything to pull back — which is exactly
    // what `null` means to the composer, leaving Escape to do its usual thing.
    rewind: () => null,
    pendingPermission,
    respond,
    // ACP has no `ask_user`: that is an Emberyx MCP tool wired for Claude. The
    // pane only calls this while a question is showing, and none ever is.
    pendingAsk: null as PendingAsk | null,
    answerAsk: () => {},
  };
}
