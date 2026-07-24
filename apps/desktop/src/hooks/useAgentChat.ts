import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAgentStore, type SubagentActivity } from "@/lib/agentStore";
import { describeTool } from "@/lib/toolDisplay";

/** A stream-json line from the headless `claude` process (Rust AgentEvent). */
type AgentEvent =
  | { type: "line"; data: string }
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
  | "error"
  | "exited";

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

export interface PendingAsk {
  id: string;
  /** Always at least one; several render as tabs. */
  questions: AskQuestion[];
}

export interface ChatUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

interface Options {
  cwd: string;
  /** Emberyx session id (for hook correlation). */
  emberyxSessionId: string;
  /** Claude session id to resume; omit to start fresh. */
  resume?: string;
  permissionMode?: string;
  /** Bypass the permission protocol entirely — no in-chat approval prompts. */
  skipPermissions?: boolean;
  /** Called with the generated title once a fresh chat has been auto-titled. */
  onTitled?: (title: string) => void;
}

let counter = 0;
const localId = () => `m${++counter}`;

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
 *  thread shows model + tokens; cost fills in after the next live turn. */
export function parseTranscriptUsage(text: string): ChatUsage {
  let inputTokens = 0;
  let outputTokens = 0;
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
    }
  }
  return { model, inputTokens, outputTokens };
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
  resume,
  permissionMode = "acceptEdits",
  skipPermissions = false,
  onTitled,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Mirror for reads inside callbacks (rewind) without stale closures or making
  // the callback re-created — and thus the composer re-rendered — every token.
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
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
  const [ready, setReady] = useState(false);
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

  // Turns typed while the agent was busy, oldest first, plus its rendered count.
  const queueRef = useRef<{ text: string; images?: ChatImage[] }[]>([]);
  const [queued, setQueued] = useState(0);
  // Mirror of status for reads inside callbacks without stale closures.
  const statusRef = useRef<ChatStatus>("idle");
  statusRef.current = status;

  const idRef = useRef<number | null>(null);
  const sessionRef = useRef<string | undefined>(resume);
  // The assistant message currently being streamed, plus block-index → tool map.
  const draftRef = useRef<ChatMessage | null>(null);
  const blockToolRef = useRef<Record<number, number>>({});
  // First user message + one-shot guard for auto-titling a fresh chat.
  const firstMsgRef = useRef<string>("");
  const titledRef = useRef(false);
  const onTitledRef = useRef(onTitled);
  onTitledRef.current = onTitled;

  const flushDraft = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) return;
    const finalized = { ...draft, streaming: false };
    draftRef.current = null;
    blockToolRef.current = {};
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
  }, []);

  const pushDraft = useCallback((patch: (d: ChatMessage) => void) => {
    const draft = draftRef.current;
    if (!draft) return;
    patch(draft);
    // Re-render with the live draft appended so text streams into the UI.
    setMessages((prev) => {
      const next = prev.slice();
      const i = next.findIndex((m) => m.id === draft.id);
      const snapshot = {
        ...draft,
        tools: draft.tools.map((t) => ({ ...t })),
      };
      if (i === -1) next.push(snapshot);
      else next[i] = snapshot;
      return next;
    });
  }, []);

  const publishTurnUsage = useCallback(() => {
    const t = turnUsageRef.current;
    const inputTokens = t.inputDone + t.curInput;
    const outputTokens = t.outputDone + t.curOutput;
    // Nothing counted yet — leave the badge as it was rather than showing 0.
    if (!inputTokens && !outputTokens) return;
    setUsage((u) =>
      u.inputTokens === inputTokens && u.outputTokens === outputTokens
        ? u
        : { ...u, inputTokens, outputTokens }
    );
  }, []);

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
        if (sid) sessionRef.current = sid;
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
          publishTurnUsage();
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
          publishTurnUsage();
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
        const ru = msg.usage as Record<string, number> | undefined;
        // `result` is authoritative; fall back to the live tally when a run ends
        // without one (errors, aborts). Read before the reset below, since the
        // state updater runs later.
        const inputTokens = ru?.input_tokens ?? (t.inputDone + t.curInput || undefined);
        const outputTokens = ru?.output_tokens ?? (t.outputDone + t.curOutput || undefined);
        setUsage((u) => ({
          ...u,
          costUsd: msg.total_cost_usd as number | undefined,
          inputTokens,
          outputTokens,
        }));
        t.active = false;
        t.inputDone = 0;
        t.outputDone = 0;
        t.curInput = 0;
        t.curOutput = 0;
        setStatus(msg.subtype === "error" ? "error" : "idle");
        // The turn is over — resolve any background runs still marked open,
        // since they never get a per-completion signal.
        endOpenSubagents(emberyxSessionId);
        return;
      }
    },
    [
      flushDraft,
      pushDraft,
      publishTurnUsage,
      emberyxSessionId,
      startSubagent,
      addSubagentActivity,
      endSubagent,
      endOpenSubagents,
    ]
  );

  // On resume, hydrate prior turns from the on-disk transcript (headless
  // --resume never replays them). Only fills when the list is still empty so it
  // can't clobber freshly streamed messages.
  useEffect(() => {
    if (!resume) return;
    let cancelled = false;
    void (async () => {
      try {
        const text = await invoke<string>("read_thread", {
          cwd,
          sessionId: resume,
        });
        if (cancelled) return;
        const hist = parseTranscript(text);
        if (hist.length) setMessages((prev) => (prev.length ? prev : hist));
        const hu = parseTranscriptUsage(text);
        setUsage((prev) =>
          prev.model || prev.costUsd != null || prev.outputTokens != null
            ? prev
            : hu
        );
      } catch (e) {
        console.error("[emberyx] read_thread failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resume, cwd]);

  // Spawn the process once per (cwd, resume) target.
  useEffect(() => {
    let disposed = false;
    const channel = new Channel<AgentEvent>();
    channel.onmessage = (ev) => {
      // Ignore late events from a torn-down effect (StrictMode double-mount kills
      // the first agent; its Exit must not flip the live session to "exited").
      if (disposed) return;
      if (ev.type === "line") handleLine(ev.data);
      else if (ev.type === "exit") setStatus("exited");
    };

    void (async () => {
      try {
        const id = await invoke<number>("agent_spawn", {
          cwd,
          sessionId: crypto.randomUUID(),
          resume: resume ?? null,
          permissionMode,
          skipPermissions,
          settings: null,
          emberyxSessionId,
          onEvent: channel,
        });
        if (disposed) {
          void invoke("agent_kill", { id });
          return;
        }
        idRef.current = id;
        setReady(true);
      } catch (e) {
        console.error("[emberyx] agent_spawn failed", e);
        setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      setReady(false);
      if (idRef.current !== null) {
        void invoke("agent_kill", { id: idRef.current });
        idRef.current = null;
      }
    };
  }, [cwd, resume, permissionMode, skipPermissions, emberyxSessionId, handleLine]);

  // Stop the current turn via a real `interrupt` control_request — aborts the
  // turn but keeps the process/session alive so the user can continue.
  const stop = useCallback(() => {
    const id = idRef.current;
    if (id === null) return;
    const line = JSON.stringify({
      type: "control_request",
      request_id: crypto.randomUUID(),
      request: { subtype: "interrupt" },
    });
    void invoke("agent_send", { id, message: line });
    setPending(null);
    setStatus("idle");
  }, [setPending]);

  // Un-send the most recent pending turn and hand its text/images back so the
  // composer can restore them for editing. If the turn is still queued it's just
  // dropped; if it's the active run it's interrupted. No-op once idle, so it
  // never eats a finished exchange.
  const rewind = useCallback((): { text: string; images?: ChatImage[] } | null => {
    if (!BUSY_STATUS.has(statusRef.current) && queueRef.current.length === 0) {
      return null;
    }
    const msgs = messagesRef.current;
    const idx = msgs.map((m) => m.role).lastIndexOf("user");
    if (idx === -1) return null;
    const restored = { text: msgs[idx].text, images: msgs[idx].images };

    if (queueRef.current.length > 0) {
      // Newest turn never left the queue — discard it, leave the active run.
      queueRef.current.pop();
      setQueued(queueRef.current.length);
    } else {
      // Newest turn is the active run — interrupt it, same wire as stop().
      const id = idRef.current;
      if (id !== null) {
        const line = JSON.stringify({
          type: "control_request",
          request_id: crypto.randomUUID(),
          request: { subtype: "interrupt" },
        });
        void invoke("agent_send", { id, message: line });
      }
      setPending(null);
      setStatus("idle");
    }
    setMessages(msgs.slice(0, idx));
    return restored;
  }, [setPending]);

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
    const unlisten = listen<PendingAsk & { session: string }>("ask-user", (ev) => {
      if (ev.payload.session !== emberyxSessionId) return;
      setPendingAsk(ev.payload);
      setStatus("awaiting_answer");
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [emberyxSessionId]);

  /** Hand a choice back to the blocked tool call. */
  const answerAsk = useCallback((answer: string) => {
    const pending = askRef.current;
    if (!pending) return;
    setPendingAsk(null);
    void invoke("answer_ask", { id: pending.id, answer });
    setStatus("thinking");
  }, []);

  /** Put a turn on the wire. Callers must have checked the agent is free. */
  const deliver = useCallback((text: string, images?: ChatImage[]) => {
    const id = idRef.current;
    const hasImages = !!images && images.length > 0;
    if (id === null) return;
    setStatus("thinking");
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
  }, []);

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
        queueRef.current.push({ text, images });
        setQueued(queueRef.current.length);
        return;
      }
      deliver(text, images);
    },
    [deliver]
  );

  // Drain one queued turn each time the agent goes idle.
  useEffect(() => {
    if (status !== "idle") return;
    const next = queueRef.current.shift();
    if (!next) return;
    setQueued(queueRef.current.length);
    deliver(next.text, next.images);
  }, [status, deliver]);

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
    send,
    queued,
    stop,
    rewind,
    pendingPermission,
    respond,
    pendingAsk,
    answerAsk,
  };
}

function attachToolResult(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  toolUseId: string,
  result: string,
  isError: boolean
) {
  setMessages((prev) =>
    prev.map((m) => {
      const ti = m.tools.findIndex((t) => t.id === toolUseId);
      if (ti === -1) return m;
      const tools = m.tools.slice();
      tools[ti] = { ...tools[ti], result, isError };
      return { ...m, tools };
    })
  );
}
