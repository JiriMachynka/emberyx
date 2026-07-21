import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Coins,
  Copy,
  Loader2,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import {
  useAgentChat,
  type ChatMessage,
  type ChatStatus,
  type ToolCall,
} from "@/hooks/useAgentChat";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";

interface ChatPaneProps {
  sessionId: string;
  cwd: string;
  resume?: string;
  active: boolean;
  fontFamily: string;
  fontSize: number;
  onTitled?: (title: string) => void;
}

/** "claude-opus-4-8" → "Opus 4.8"; strips date/bracket suffixes. */
const prettyModel = (id: string): string => {
  const family = ["opus", "sonnet", "haiku", "fable"].find((f) =>
    id.includes(f)
  );
  if (!family) return id;
  const nums = id.replace(/\[.*?\]/g, "").replace(/\d{8}/g, "").match(/\d+/g);
  const version = (nums ?? []).slice(0, 2).join(".");
  const name = family[0].toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name;
};

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "",
  thinking: "Thinking…",
  streaming: "Responding…",
  tool: "Running tool…",
  error: "Error",
  exited: "Session ended",
};

export function ChatPane({
  sessionId,
  cwd,
  resume,
  active,
  fontFamily,
  fontSize,
  onTitled,
}: ChatPaneProps) {
  const { messages, status, usage, ready, send, stop } = useAgentChat({
    cwd,
    emberyxSessionId: sessionId,
    resume,
    onTitled,
  });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Stick to the bottom as messages stream in, and when this pane is revealed.
  // Resumed threads hydrate their history while the pane is still hidden
  // (display:none → scrollHeight is 0), so an rAF after reveal lets layout and
  // syntax highlighting settle before we jump to the end.
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages, active]);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const submit = () => {
    if (!input.trim() || !ready) return;
    send(input);
    setInput("");
  };

  const busy = status === "thinking" || status === "streaming" || status === "tool";

  return (
    <div className="flex h-full w-full flex-col">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ fontFamily, fontSize: `${fontSize}px` }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
          {messages.length === 0 && (
            <div className="mt-24 text-center text-sm text-muted-foreground">
              {ready ? "Send a message to start." : "Starting agent…"}
            </div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} fontSize={fontSize} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {STATUS_LABEL[status]}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border px-5 py-3">
        <div className="mx-auto max-w-3xl">
          {status === "exited" && (
            <div className="mb-2 text-center text-xs text-muted-foreground">
              Session ended — open a new chat to continue.
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-input bg-card shadow-sm transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                status === "exited"
                  ? "Session ended"
                  : ready
                    ? "Message Claude…"
                    : "Starting agent…"
              }
              disabled={!ready || busy || status === "exited"}
              rows={2}
              className="max-h-40 resize-none border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
              <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
                {usage.model && (
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <Sparkles className="size-3.5 shrink-0 text-primary" />
                    <span className="truncate">{prettyModel(usage.model)}</span>
                  </span>
                )}
                {(usage.inputTokens != null ||
                  usage.outputTokens != null ||
                  usage.costUsd != null) && (
                  <span className="flex items-center gap-2 font-mono tabular-nums">
                    {usage.inputTokens != null && (
                      <span className="flex items-center gap-0.5">
                        <ArrowDown className="size-3 opacity-60" />
                        {usage.inputTokens.toLocaleString("en-US")}
                      </span>
                    )}
                    {usage.outputTokens != null && (
                      <span className="flex items-center gap-0.5">
                        <ArrowUp className="size-3 opacity-60" />
                        {usage.outputTokens.toLocaleString("en-US")}
                      </span>
                    )}
                    {usage.costUsd != null && (
                      <span className="flex items-center gap-0.5 text-primary">
                        <Coins className="size-3 opacity-70" />
                        ${usage.costUsd.toFixed(4)}
                      </span>
                    )}
                  </span>
                )}
              </div>
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  title="Stop"
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-foreground transition-colors hover:bg-muted"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={!input.trim() || !ready || status === "exited"}
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message, fontSize }: { message: ChatMessage; fontSize: number }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-card px-4 py-2.5">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="group relative flex flex-col gap-2">
      {message.thinking && <ThinkingBlock text={message.thinking} />}
      {message.tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
      {message.text &&
        (message.streaming ? (
          <div className="whitespace-pre-wrap leading-relaxed text-foreground">
            {message.text}
          </div>
        ) : (
          <Markdown text={message.text} fontSize={fontSize} />
        ))}
      {message.text && !message.streaming && <CopyButton text={message.text} />}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy message"
      className="absolute left-0 top-full flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        Thinking
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap pl-4 opacity-80">{text}</div>}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card/50 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Wrench className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{tool.name}</span>
        {tool.result == null ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        ) : (
          <span
            className={cn(
              "ml-auto text-[0.7rem]",
              tool.isError ? "text-red-400" : "text-muted-foreground"
            )}
          >
            {tool.isError ? "error" : "done"}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[0.7rem] text-muted-foreground">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.result != null && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border-t border-border pt-2 font-mono text-[0.7rem] text-muted-foreground">
              {tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
