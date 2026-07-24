import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "diff";
import {
  Blocks,
  Bot,
  Brain,
  Check,
  ChevronRight,
  ClipboardList,
  Copy,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  MessageCircleQuestionMark,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  describeResult,
  describeTool,
  stripReminders,
  type TodoItem,
  type ToolBodyPart,
  type ToolIcon,
} from "@/lib/toolDisplay";
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
import { AgentChips } from "@/components/AgentChips";
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
  skipPermissions: boolean;
  onTitled?: (title: string) => void;
}

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "",
  thinking: "Thinking…",
  streaming: "Responding…",
  tool: "Running tool…",
  awaiting_permission: "Waiting for your decision…",
  awaiting_answer: "Waiting for your answer…",
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
  skipPermissions,
  onTitled,
}: ChatPaneProps) {
  const {
    messages,
    status,
    usage,
    ready,
    send,
    queued,
    stop,
    pendingPermission,
    respond,
    pendingAsk,
    answerAsk,
  } = useAgentChat({
    cwd,
    emberyxSessionId: sessionId,
    resume,
    skipPermissions,
    onTitled,
  });
  const [preview, setPreview] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Drives the elapsed counters on the agent chips.
  const [now, setNow] = useState(() => Date.now());

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

  // While a tool runs, say what it's doing instead of a generic "Running tool…".
  let statusLabel = STATUS_LABEL[status];
  if (status === "tool") {
    const running = messages[messages.length - 1]?.tools.find((t) => t.result == null);
    if (running) {
      const d = describeTool(running.name, running.input);
      statusLabel = d.title ? `${d.label} ${d.title}` : d.label;
    }
  }

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
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
              <span className="min-w-0 truncate">{statusLabel}</span>
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
          <AgentChips session={sessionId} now={now} />
          {/* A prompt replaces the composer rather than stacking above it —
              two focusable surfaces competing for the same keys is what made
              picking an option unreliable. Permission wins if both are live. */}
          {pendingPermission ? (
            <PermissionPrompt pending={pendingPermission} onDecide={respond} />
          ) : pendingAsk ? (
            <AskPrompt pending={pendingAsk} onAnswer={answerAsk} />
          ) : (
            <ChatComposer
              cwd={cwd}
              active={active}
              ready={ready}
              busy={busy}
              queued={queued}
              exited={status === "exited"}
              usage={usage}
              onSend={send}
              onStop={stop}
              onPreview={setPreview}
            />
          )}
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
      {message.tools.length > 0 && (
        <div className="flex flex-col gap-1">
          {message.tools.map((t) => (
            <ToolCard key={t.id} tool={t} />
          ))}
        </div>
      )}
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

/** Reasoning, kept out of the way: a borderless dashed strip rather than a
 *  card, so it never reads as a tool call. Always starts collapsed. */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 italic hover:text-foreground"
      >
        <Brain className="size-3.5 shrink-0 opacity-70" />
        Thought for a moment
        <ChevronRight
          className={cn("ml-auto size-3 transition-transform", open && "rotate-90")}
        />
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

const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  task: Bot,
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: Terminal,
  search: Search,
  globe: Globe,
  list: ListTodo,
  plan: ClipboardList,
  mcp: Blocks,
  tool: Wrench,
};

/** A steady per-tool hue so a run of cards is scannable without reading labels. */
const TOOL_TINT: Record<ToolIcon, string> = {
  task: "text-violet-400",
  read: "text-sky-400",
  write: "text-emerald-400",
  edit: "text-amber-400",
  bash: "text-teal-300",
  search: "text-cyan-400",
  globe: "text-blue-400",
  list: "text-pink-400",
  plan: "text-indigo-400",
  mcp: "text-orange-400",
  tool: "text-muted-foreground",
};

const TODO_MARK: Record<TodoItem["status"], { mark: string; className: string }> = {
  completed: { mark: "✓", className: "text-emerald-400 line-through opacity-60" },
  in_progress: { mark: "▸", className: "text-primary" },
  pending: { mark: "○", className: "text-muted-foreground" },
};

/** Old vs new for an Edit, as a syntax-highlighted unified diff. */
function ToolDiff({ before, after, lang }: { before: string; after: string; lang: string | null }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre font-mono text-[0.7rem] leading-relaxed">
      <div className="w-max min-w-full">
        {parts.map((part, i) =>
          part.value
            .replace(/\n$/, "")
            .split("\n")
            .map((line, j) => (
              <div
                key={`${i}-${j}`}
                className={cn(
                  "flex gap-2 border-l-2 px-1",
                  part.added
                    ? "border-emerald-500/50 bg-emerald-500/15"
                    : part.removed
                      ? "border-red-500/50 bg-red-500/15"
                      : "border-transparent"
                )}
              >
                <span className="select-none text-muted-foreground">
                  {part.added ? "+" : part.removed ? "-" : " "}
                </span>
                <code
                  className="hljs"
                  style={{ background: "transparent", padding: 0 }}
                  dangerouslySetInnerHTML={{ __html: highlightCode(line, lang) }}
                />
              </div>
            ))
        )}
      </div>
    </pre>
  );
}

/** One chunk of a tool's expanded input, rendered per part kind. */
function ToolBody({ part }: { part: ToolBodyPart }) {
  const label = "label" in part && part.label && (
    <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
      {part.label}
    </div>
  );

  if (part.kind === "fields") {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.7rem]">
        {part.rows.map((row) => (
          <Fragment key={row.key}>
            <dt className="text-muted-foreground">{row.key}</dt>
            <dd className="truncate font-mono" title={row.value}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  if (part.kind === "todos") {
    return (
      <ul className="flex flex-col gap-1 text-[0.7rem]">
        {part.items.map((item, idx) => {
          const style = TODO_MARK[item.status];
          return (
            <li key={idx} className="flex gap-2">
              <span className={cn("select-none", style.className)}>{style.mark}</span>
              <span className={item.status === "completed" ? "opacity-60 line-through" : ""}>
                {item.text}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  if (part.kind === "diff") {
    return (
      <div>
        {label}
        <ToolDiff before={part.before} after={part.after} lang={part.lang} />
      </div>
    );
  }

  if (part.kind === "text") {
    return (
      <div>
        {label}
        <div className="max-h-64 overflow-auto whitespace-pre-wrap text-[0.7rem] leading-relaxed text-muted-foreground">
          {part.text}
        </div>
      </div>
    );
  }

  return (
    <div>
      {label}
      <ToolCode code={part.code} lang={part.lang} className="max-h-64 overflow-auto" />
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const display = describeTool(tool.name, tool.input);
  const Icon = TOOL_ICONS[display.icon];
  const running = tool.result == null;
  const expandable = display.body.length > 0 || tool.result != null;
  // Follows the run — open while working, closed once done — until the user
  // takes over by clicking, after which their choice sticks. Agents are the
  // exception: their prompt is long and their progress lives in the side panel,
  // so the card stays shut and just spins.
  const [override, setOverride] = useState<boolean | null>(null);
  const isAgent = display.icon === "task";
  const open = (override ?? (running && !isAgent)) && expandable;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/50 text-xs">
      <button
        type="button"
        onClick={() => expandable && setOverride(!open)}
        disabled={!expandable}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
          expandable && "hover:bg-muted/40"
        )}
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            tool.isError ? "text-red-400" : TOOL_TINT[display.icon],
            running && "animate-pulse"
          )}
        />
        <span className="shrink-0 font-medium">{display.label}</span>
        {display.title && (
          <span
            className={cn(
              "min-w-0 truncate text-muted-foreground",
              display.mono && "font-mono text-[0.7rem]"
            )}
          >
            {display.title}
          </span>
        )}
        {display.meta && (
          <span className="shrink-0 rounded border border-border px-1.5 py-px text-[0.65rem] text-muted-foreground">
            {display.meta}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {running ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : tool.isError ? (
            <span className="text-[0.7rem] text-red-400">error</span>
          ) : (
            <Check className="size-3.5 text-emerald-400" />
          )}
          {expandable && (
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground transition-transform duration-200",
                open && "rotate-90"
              )}
            />
          )}
        </div>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
            {display.body.map((part, idx) => (
              <ToolBody key={idx} part={part} />
            ))}
            {tool.result != null &&
              describeResult(stripReminders(tool.result)).map((part, idx) => (
                <div
                  key={idx}
                  className={cn(
                    idx === 0 &&
                      display.body.length > 0 &&
                      "border-t border-border pt-2"
                  )}
                >
                  <ToolBody part={part} />
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the agent is asking to run, in the same shape the tool cards use. */
function PermissionSummary({ toolName, input }: { toolName: string; input: unknown }) {
  const display = describeTool(toolName, input);
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-md bg-muted/40 p-2 text-xs">
      {display.title && (
        <div className={cn("break-all", display.mono && "font-mono text-[0.7rem]")}>
          {display.title}
        </div>
      )}
      {display.meta && <div className="text-[0.65rem] text-muted-foreground">{display.meta}</div>}
      {display.body.map((part, idx) => (
        <ToolBody key={idx} part={part} />
      ))}
    </div>
  );
}

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

/** The agent's question(s), from the ask_user tool. Replaces the composer while
 *  open. Several questions render as tabs: ←→ switches tab, ↑↓ moves the
 *  highlight, 1–9 picks, Space toggles a multi-select row, Enter confirms.
 *
 *  Keys are taken on `window` rather than from a focused container: the old
 *  focus-based contract silently dropped every keystroke once focus drifted
 *  anywhere else, which read as "the picker ignored my selection". */
function AskPrompt({
  pending,
  onAnswer,
}: {
  pending: PendingAsk;
  onAnswer: (answer: string) => void;
}) {
  const questions = pending.questions;
  const [tab, setTab] = useState(0);
  const [active, setActive] = useState<number[]>(() => questions.map(() => 0));
  const [picked, setPicked] = useState<number[][]>(() => questions.map(() => []));
  const rowRef = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setTab(0);
    setActive(questions.map(() => 0));
    setPicked(questions.map(() => []));
  }, [pending.id, questions]);

  const submit = (all: number[][]) => {
    const parts = questions.map((q, qi) => {
      const labels = all[qi].map((i) => q.options[i].label).join(", ");
      return questions.length === 1 ? labels : `${q.header || q.question}: ${labels}`;
    });
    onAnswer(parts.join("\n"));
  };

  /** Pick (single) or toggle (multi) an option, then advance or submit. */
  const choose = (qi: number, oi: number) => {
    setActive((a) => a.map((v, i) => (i === qi ? oi : v)));
    if (questions[qi].multiSelect) {
      setPicked((p) =>
        p.map((v, i) =>
          i === qi
            ? v.includes(oi)
              ? v.filter((x) => x !== oi)
              : [...v, oi].sort((a, b) => a - b)
            : v
        )
      );
      return;
    }
    const next = picked.map((v, i) => (i === qi ? [oi] : v));
    setPicked(next);
    const missing = next.findIndex((v) => v.length === 0);
    if (missing === -1) submit(next);
    else setTab(missing);
  };

  const confirm = () => {
    const q = questions[tab];
    if (q.multiSelect && picked[tab].length === 0) {
      choose(tab, active[tab]);
      return;
    }
    const missing = picked.findIndex((v) => v.length === 0);
    if (missing === -1) submit(picked);
    else setTab(missing);
  };

  // No dep array: re-registered each render so the handler never closes over
  // stale selection state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const q = questions[tab];
      const count = q.options.length;
      const move = (delta: number) =>
        setActive((a) => a.map((v, i) => (i === tab ? (v + delta + count) % count : v)));

      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "ArrowRight" && questions.length > 1) {
        e.preventDefault();
        setTab((t) => (t + 1) % questions.length);
      } else if (e.key === "ArrowLeft" && questions.length > 1) {
        e.preventDefault();
        setTab((t) => (t - 1 + questions.length) % questions.length);
      } else if (e.key === " " && q.multiSelect) {
        e.preventDefault();
        choose(tab, active[tab]);
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < count) {
          e.preventDefault();
          choose(tab, idx);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    rowRef.current[active[tab]]?.scrollIntoView({ block: "nearest" });
  }, [tab, active]);

  const question = questions[tab];
  const complete = picked.every((v) => v.length > 0);

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      {questions.length > 1 && (
        <div className="mb-2 flex items-center gap-1 border-b border-border pb-2">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setTab(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                i === tab
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {picked[i]?.length > 0 && <Check className="size-3 text-emerald-400" />}
              {q.header || `Question ${i + 1}`}
            </button>
          ))}
          <span className="ml-auto text-[0.65rem] text-muted-foreground">←→ to switch</span>
        </div>
      )}

      <div className="mb-2 flex items-start gap-2 text-sm">
        <MessageCircleQuestionMark className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span className="font-medium">{question.question}</span>
        {questions.length === 1 && question.header && (
          <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">
            {question.header}
          </span>
        )}
      </div>

      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {question.options.map((o, i) => {
          const isPicked = picked[tab]?.includes(i);
          return (
            <button
              key={i}
              ref={(el) => {
                rowRef.current[i] = el;
              }}
              type="button"
              onClick={() => choose(tab, i)}
              className={cn(
                "flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                i === active[tab]
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <kbd
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-border font-mono text-xs",
                  isPicked ? "bg-primary text-primary-foreground" : "bg-background"
                )}
              >
                {isPicked ? "✓" : i + 1}
              </kbd>
              <span className="min-w-0">
                <span className="block text-foreground">{o.label}</span>
                {o.description && (
                  <span className="block text-xs text-muted-foreground">{o.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {question.multiSelect
            ? "Space or click toggles, Enter confirms."
            : `1–${question.options.length}, ↑↓ + Enter, or click.`}
        </p>
        {(question.multiSelect || questions.length > 1) && (
          <button
            type="button"
            onClick={confirm}
            disabled={!complete}
            className={cn(
              "ml-auto rounded-lg px-3 py-1 text-xs transition-colors",
              complete
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground"
            )}
          >
            Submit
          </button>
        )}
      </div>
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

  useEffect(() => {
    setActive(0);
  }, [pending.requestId]);

  // Window-level, same reason as AskPrompt: focus can drift, keys shouldn't.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <Wrench className="size-3.5 text-primary" />
        <span className="font-medium">{pending.toolName}</span>
        <span className="text-xs text-muted-foreground">needs permission</span>
      </div>
      <PermissionSummary toolName={pending.toolName} input={pending.input} />
      <div className="flex flex-col gap-1">
        {options.map((o, i) => (
          <button
            key={o.key}
            type="button"
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
