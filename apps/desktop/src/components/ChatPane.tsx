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
  X,
} from "lucide-react";
import {
  useAgentChat,
  type ChatImage,
  type ChatMessage,
  type ChatStatus,
  type PendingPermission,
  type PermissionDecision,
  type ToolCall,
} from "@/hooks/useAgentChat";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/Markdown";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/** Reconstruct a data: URL for rendering from a stored ChatImage. */
const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;

/** Anthropic downsizes vision inputs past this; do it client-side to keep the
 *  base64 (which lives in the in-memory message history) small. */
const MAX_EDGE = 1568;

const processImage = (file: File): Promise<ChatImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const strip = (url: string, mediaType: string): ChatImage => ({
        id: crypto.randomUUID(),
        mediaType,
        data: url.slice(url.indexOf(",") + 1),
      });
      const img = new Image();
      img.onerror = () => resolve(strip(dataUrl, file.type));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1) {
          resolve(strip(dataUrl, file.type));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(strip(dataUrl, file.type));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const type = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(strip(canvas.toDataURL(type, 0.9), type));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

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
  const { messages, status, usage, ready, send, stop, pendingPermission, respond } =
    useAgentChat({
      cwd,
      emberyxSessionId: sessionId,
      resume,
      onTitled,
    });
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
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

  // Grow the composer with its content, capped by max-h-40 (then it scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const submit = () => {
    if ((!input.trim() && images.length === 0) || !ready) return;
    send(input, images);
    setInput("");
    setImages([]);
  };

  const appendImages = (files: File[]) => {
    if (files.length === 0) return;
    void Promise.all(files.map(processImage)).then((imgs) => {
      setImages((prev) => [...prev, ...imgs]);
    });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    appendImages(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    appendImages(
      Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))
    );
  };

  const busy = status === "thinking" || status === "streaming" || status === "tool";

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
              onPreview={setPreview}
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
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              "overflow-hidden rounded-xl border border-input bg-card shadow-sm transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40",
              dragging && "border-ring ring-1 ring-ring/50"
            )}
          >
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3.5 pt-3">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="group relative size-14 overflow-hidden rounded-lg border border-border"
                  >
                    <button
                      type="button"
                      onClick={() => setPreview(imageSrc(img))}
                      className="block size-full"
                    >
                      <img
                        src={imageSrc(img)}
                        alt=""
                        className="size-full object-cover"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setImages((prev) => prev.filter((i) => i.id !== img.id))
                      }
                      className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
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
              disabled={
                !ready || busy || status === "exited" || pendingPermission != null
              }
              rows={1}
              className="max-h-40 min-h-16 resize-none overflow-y-auto border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none focus-visible:ring-0"
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
                  disabled={
                    (!input.trim() && images.length === 0) ||
                    !ready ||
                    status === "exited"
                  }
                  className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
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

function MessageRow({
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
