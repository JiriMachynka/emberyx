import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Loader2,
  MessageCircleQuestionMark,
  Wrench,
} from "lucide-react";
import {
  useAgentChat,
  type ChatImage,
  type ChatMessage,
  type ChatStatus,
  type PendingAsk,
  type PendingPermission,
  type PermissionDecision,
  type ToolCall,
} from "@/hooks/useAgentChat";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/Markdown";
import { ChatComposer } from "@/components/ChatComposer";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/** Reconstruct a data: URL for rendering from a stored ChatImage. */
const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;

interface ChatPaneProps {
  sessionId: string;
  cwd: string;
  resume?: string;
  active: boolean;
  fontFamily: string;
  fontSize: number;
  onTitled?: (title: string) => void;
}

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "",
  thinking: "Thinking…",
  streaming: "Responding…",
  tool: "Running tool…",
  awaiting_permission: "Waiting for your decision…",
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
  const {
    messages,
    status,
    usage,
    ready,
    send,
    stop,
    pendingPermission,
    respond,
    pendingAsk,
    answerAsk,
  } = useAgentChat({
    cwd,
    emberyxSessionId: sessionId,
    resume,
    onTitled,
  });
  const [preview, setPreview] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const busy = status === "thinking" || status === "streaming" || status === "tool";
  // Stable across renders so memoized rows don't re-render on every update.
  const openPreview = useCallback((dataUrl: string) => setPreview(dataUrl), []);

  return (
    <div className="flex h-full w-full flex-col" style={{ fontFamily }}>
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
            <MessageRow
              key={m.id}
              message={m}
              fontSize={fontSize}
              onPreview={openPreview}
            />
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
          {pendingPermission && (
            <div className="mb-2">
              <PermissionPrompt pending={pendingPermission} onDecide={respond} />
            </div>
          )}
          {pendingAsk && (
            <div className="mb-2">
              <AskPrompt pending={pendingAsk} onAnswer={answerAsk} />
            </div>
          )}
          <ChatComposer
            cwd={cwd}
            active={active}
            ready={ready}
            busy={busy}
            exited={status === "exited"}
            blocked={pendingPermission != null || pendingAsk != null}
            usage={usage}
            onSend={send}
            onStop={stop}
            onPreview={setPreview}
          />
        </div>
      </div>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl border-0 bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          {preview && (
            <img
              src={preview}
              alt=""
              className="max-h-[80vh] w-full rounded-lg object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Memoized: while a message is streaming only its own row re-renders, and
 *  typing in the composer re-renders none of them. */
const MessageRow = memo(function MessageRow({
  message,
  fontSize,
  onPreview,
}: {
  message: ChatMessage;
  fontSize: number;
  onPreview: (dataUrl: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.images && message.images.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {message.images.map((img) => (
              <button
                key={img.id}
                type="button"
                onClick={() => onPreview(imageSrc(img))}
                className="size-20 overflow-hidden rounded-lg border border-border"
              >
                <img
                  src={imageSrc(img)}
                  alt=""
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {message.text && (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-card px-4 py-2.5">
            {message.text}
          </div>
        )}
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
});

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
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="mt-1 whitespace-pre-wrap pl-4 opacity-80">{text}</div>
        </div>
      </div>
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
        <div className="ml-auto flex items-center gap-2">
          {tool.result == null ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <span
              className={cn(
                "text-[0.7rem]",
                tool.isError ? "text-red-400" : "text-muted-foreground"
              )}
            >
              {tool.isError ? "error" : "done"}
            </span>
          )}
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground transition-transform duration-200",
              open && "rotate-90"
            )}
          />
        </div>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border px-3 py-2">
            <ToolCode code={JSON.stringify(tool.input, null, 2)} lang="json" />
            {tool.result != null &&
              (() => {
                const { code, lang } = detectResult(stripReminders(tool.result));
                return (
                  <ToolCode
                    code={code}
                    lang={lang}
                    className="mt-2 max-h-48 overflow-auto border-t border-border pt-2"
                  />
                );
              })()}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Drop harness-injected <system-reminder> blocks from displayed tool output
 *  (Claude still received them in-band — this is display-only noise removal). */
const stripReminders = (text: string): string =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");

/** Pretty-print + tag as json when a tool result is JSON; else leave as-is. */
const detectResult = (result: string): { code: string; lang: string | null } => {
  const trimmed = result.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { code: JSON.stringify(JSON.parse(trimmed), null, 2), lang: "json" };
    } catch {
      // not valid JSON — fall through to plain text
    }
  }
  return { code: result, lang: null };
};

function ToolCode({
  code,
  lang,
  className,
}: {
  code: string;
  lang: string | null;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap font-mono text-[0.7rem]",
        className
      )}
    >
      <code
        className="hljs"
        style={{ background: "transparent", padding: 0 }}
        dangerouslySetInnerHTML={{ __html: highlightCode(code, lang) }}
      />
    </pre>
  );
}

/** The agent's own question, from the ask_user tool. Same keyboard contract as
 *  the permission prompt: number keys, arrows + Enter, or click. Multi-select
 *  toggles rows and confirms with Enter. */
function AskPrompt({
  pending,
  onAnswer,
}: {
  pending: PendingAsk;
  onAnswer: (answer: string) => void;
}) {
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActive(0);
    setChosen(new Set());
    ref.current?.focus();
  }, [pending.id]);

  const answerWith = (indexes: number[]) => {
    const labels = indexes.map((i) => pending.options[i].label);
    if (labels.length) onAnswer(labels.join(", "));
  };

  const pick = (i: number) => {
    if (!pending.multiSelect) {
      answerWith([i]);
      return;
    }
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const count = pending.options.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (pending.multiSelect && chosen.size) answerWith([...chosen].sort());
      else pick(active);
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < count) {
        e.preventDefault();
        pick(idx);
      }
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-border bg-card p-3 shadow-sm outline-none ring-1 ring-transparent focus:ring-ring/40"
    >
      <div className="mb-2 flex items-center gap-2 text-sm">
        <MessageCircleQuestionMark className="size-3.5 text-primary" />
        <span className="font-medium">{pending.question}</span>
        {pending.header && (
          <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">
            {pending.header}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {pending.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(i)}
            className={cn(
              "flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
              i === active
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            <kbd
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-border font-mono text-xs",
                chosen.has(i) ? "bg-primary text-primary-foreground" : "bg-background"
              )}
            >
              {chosen.has(i) ? "✓" : i + 1}
            </kbd>
            <span className="min-w-0">
              <span className="block text-foreground">{o.label}</span>
              {o.description && (
                <span className="block text-xs text-muted-foreground">
                  {o.description}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {pending.multiSelect
          ? "Toggle with 1–9 or click, Enter to confirm."
          : `Press 1–${pending.options.length}, ↑↓ + Enter, or click.`}
      </p>
    </div>
  );
}

/** Permission prompt for a pending can_use_tool request. Selectable by number
 *  key, arrow keys + Enter, or mouse click. */
function PermissionPrompt({
  pending,
  onDecide,
}: {
  pending: PendingPermission;
  onDecide: (d: PermissionDecision) => void;
}) {
  const options: { key: PermissionDecision; label: string }[] = [
    { key: "allow_once", label: "Allow once" },
    ...(pending.suggestions.length > 0
      ? [{ key: "allow_always" as const, label: "Allow always" }]
      : []),
    { key: "deny", label: "Deny" },
  ];
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActive(0);
    ref.current?.focus();
  }, [pending.requestId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onDecide(options[active].key);
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < options.length) {
        e.preventDefault();
        onDecide(options[idx].key);
      }
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="rounded-xl border border-border bg-card p-3 shadow-sm outline-none ring-1 ring-transparent focus:ring-ring/40"
    >
      <div className="mb-2 flex items-center gap-2 text-sm">
        <Wrench className="size-3.5 text-primary" />
        <span className="font-medium">{pending.toolName}</span>
        <span className="text-xs text-muted-foreground">needs permission</span>
      </div>
      <ToolCode
        code={JSON.stringify(pending.input, null, 2)}
        lang="json"
        className="mb-2 max-h-24 overflow-auto rounded-md bg-muted/40 p-2"
      />
      <div className="flex flex-col gap-1">
        {options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => onDecide(o.key)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
              i === active
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            <kbd className="grid size-5 shrink-0 place-items-center rounded border border-border bg-background font-mono text-xs">
              {i + 1}
            </kbd>
            <span className={cn(o.key === "deny" && "text-red-400")}>
              {o.label}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Press 1–{options.length}, ↑↓ + Enter, or click.
      </p>
    </div>
  );
}
