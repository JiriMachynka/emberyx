import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

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
}

export type ChatStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "error"
  | "exited";

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
  onTitled,
}: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [usage, setUsage] = useState<ChatUsage>({});
  const [ready, setReady] = useState(false);

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
          const model = (ev.message as Record<string, unknown> | undefined)
            ?.model as string | undefined;
          if (model) setUsage((u) => ({ ...u, model }));
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
              try {
                d.tools[ti].input = JSON.parse(d.tools[ti].partial || "{}");
              } catch {
                /* keep partial */
              }
            }
          });
        } else if (evType === "message_stop") {
          flushDraft();
        }
        return;
      }

      // Tool results arrive as a `user` message with tool_result content blocks.
      if (type === "user") {
        const content = (msg.message as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "tool_result") {
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
        setUsage((u) => ({
          ...u,
          costUsd: msg.total_cost_usd as number | undefined,
          inputTokens: (msg.usage as Record<string, number>)?.input_tokens,
          outputTokens: (msg.usage as Record<string, number>)?.output_tokens,
        }));
        setStatus(msg.subtype === "error" ? "error" : "idle");
        return;
      }
    },
    [flushDraft, pushDraft]
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
  }, [cwd, resume, permissionMode, emberyxSessionId, handleLine]);

  // Stop the current run. In modes-only v1 this ends the process (the session
  // stays on disk and can be resumed); true mid-turn interrupt needs the
  // control protocol, which v1 deliberately skips.
  const stop = useCallback(() => {
    const id = idRef.current;
    if (id === null) return;
    void invoke("agent_kill", { id });
    idRef.current = null;
    setStatus("exited");
  }, []);

  const send = useCallback((text: string) => {
    const id = idRef.current;
    if (id === null || !text.trim()) return;
    setMessages((prev) => [
      ...prev,
      {
        id: localId(),
        role: "user",
        text,
        thinking: "",
        tools: [],
        streaming: false,
      },
    ]);
    if (!firstMsgRef.current) firstMsgRef.current = text;
    setStatus("thinking");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    void invoke("agent_send", { id, message: line });
  }, []);

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

  return { messages, status, usage, ready, send, stop };
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
