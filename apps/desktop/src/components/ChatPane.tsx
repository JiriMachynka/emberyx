import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Loader2, Square, Wrench } from "lucide-react";
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
  fontSize: number;
  onTitled?: (title: string) => void;
}

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
        style={{ fontSize: `${fontSize}px` }}
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
          <div className="relative">
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
              className="resize-none pr-11"
            />
            {busy ? (
              <button
                type="button"
                onClick={stop}
                title="Stop"
                className="absolute bottom-2 right-2 grid size-7 place-items-center rounded-md bg-card text-foreground transition-colors hover:bg-muted"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!input.trim() || !ready || status === "exited"}
                className="absolute bottom-2 right-2 grid size-7 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
          {usage.costUsd != null && (
            <div className="mt-1.5 text-right font-mono text-[0.7rem] text-muted-foreground">
              ${usage.costUsd.toFixed(4)} · {usage.outputTokens ?? 0} out
            </div>
          )}
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
    <div className="flex flex-col gap-2">
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
    </div>
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
