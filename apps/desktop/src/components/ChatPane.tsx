import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { diffLines } from "diff";
import {
  ArrowRightLeft,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  LogIn,
  MessageCircleQuestionMark,
  RotateCw,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { issueTitle, resetLabel, type AccountIssue } from "@/lib/accountState";
import { BACKEND_LABEL, type AgentBackend } from "@/lib/agentBackend";
import {
  describeResult,
  describeTool,
  stripReminders,
  type TodoItem,
  type ToolBodyPart,
} from "@/lib/toolDisplay";
import { TOOL_ICONS, TOOL_TINT } from "@/lib/toolIcons";
import { useChatSession } from "@/hooks/useChatSession";
import {
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/Markdown";
import { ChatComposer } from "@/components/ChatComposer";
import {
  handoffLabel,
  handoffTurnsFrom,
  otherBackend,
  renderHandoffContext,
  withFocusedTurn,
} from "@/lib/handoff";
import {
  EMPTY_THREAD,
  carryOver,
  mergeThread,
  switchBefore,
  type CarriedThread,
  type ProviderSwitchMark,
} from "@/lib/thread";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import { useInvalidateGit } from "@/lib/queries";
import {
  checkpointChanges,
  describeRestore,
  restoreCheckpoint,
} from "@/lib/checkpoints";
import type { PermissionMode } from "@/lib/settings";
import { PROVIDER_LABEL } from "@/lib/providers";
import { useGitChanges } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import { type RegistryAgent } from "@/lib/agentRegistry";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/** Reconstruct a data: URL for rendering from a stored ChatImage. */
const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;

/** Highlighting is pure but hot — a diff re-highlights every line on each
 *  render, at token frequency. Cache by code+language, evicting least-recently
 *  used, so a streaming pane pays for each line once. */
const HIGHLIGHT_CACHE = new Map<string, string>();
const HIGHLIGHT_CACHE_LIMIT = 1000;

const highlightCached = (code: string, lang: string | null): string => {
  const key = `${lang ?? ""}\x00${code}`;
  const hit = HIGHLIGHT_CACHE.get(key);
  if (hit !== undefined) {
    HIGHLIGHT_CACHE.delete(key);
    HIGHLIGHT_CACHE.set(key, hit);
    return hit;
  }
  const html = highlightCode(code, lang);
  HIGHLIGHT_CACHE.set(key, html);
  if (HIGHLIGHT_CACHE.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = HIGHLIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) HIGHLIGHT_CACHE.delete(oldest);
  }
  return html;
};

interface ChatPaneProps {
  sessionId: string;
  cwd: string;
  resume?: string;
  /** Agent CLI this chat drives; gates the Claude-only composer surfaces. */
  backend: AgentBackend;
  active: boolean;
  fontFamily: string;
  fontSize: number;
  skipPermissions: boolean;
  /** Run the agent in the daemon so it outlives this window. */
  persistent: boolean;
  /** Claude's --permission-mode; ignored when permissions are skipped. */
  permissionMode: PermissionMode;
  /** Default `--model` alias for new chats; "" = CLI default. */
  model: string;
  /** Persist a new default when the user switches this pane's model. */
  onModelChange: (model: string) => void;
  /** Default reasoning effort for new chats; "" = let the CLI decide. */
  effort: string;
  /** Persist a new default when the user switches this pane's effort. */
  onEffortChange: (effort: string) => void;
  onTitled?: (title: string) => void;
}

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "",
  thinking: "Thinking…",
  streaming: "Responding…",
  tool: "Running tool…",
  awaiting_permission: "Waiting for your decision…",
  awaiting_answer: "Waiting for your answer…",
  retrying: "Server busy, retrying…",
  error: "Error",
  exited: "Session ended",
};

export const ChatPane = memo(function ChatPane({
  sessionId,
  cwd,
  resume,
  backend,
  active,
  fontFamily,
  fontSize,
  skipPermissions,
  persistent,
  permissionMode,
  model,
  onModelChange,
  effort,
  onEffortChange,
  onTitled,
}: ChatPaneProps) {
  // Seed from the global default but keep the running model local so switching
  // it respawns only this pane, not every mounted chat.
  const [activeModel, setActiveModel] = useState(model);
  const changeModel = useCallback(
    (m: string) => {
      setActiveModel(m);
      onModelChange(m);
    },
    [onModelChange]
  );
  // Effort is its own axis, not part of the model — for Claude it's a launch
  // flag (so a change respawns this pane), for Codex a per-turn param.
  const [activeEffort, setActiveEffort] = useState(effort);
  const changeEffort = useCallback(
    (e: string) => {
      setActiveEffort(e);
      onEffortChange(e);
    },
    [onEffortChange]
  );
  // Approval posture is a spawn-time flag, kept local so switching it respawns
  // just this pane (via --resume), like the model.
  const [fullAccess, setFullAccess] = useState(skipPermissions);
  // The provider this thread is on *right now*. It starts as the session's, but
  // a thread can change hands mid-conversation — the turns each provider
  // produced stay in the same visual transcript, stamped with who made them.
  const [activeBackend, setActiveBackend] = useState<AgentBackend>(backend);
  const [carried, setCarried] = useState<CarriedThread>(EMPTY_THREAD);
  const {
    messages,
    status,
    usage,
    ready,
    send,
    rewind,
    queued,
    queue,
    stop,
    restart,
    exitReason,
    pendingPermission,
    respond,
    pendingAsk,
    answerAsk,
  } = useChatSession({
    cwd,
    emberyxSessionId: sessionId,
    resume,
    backend: activeBackend,
    skipPermissions: fullAccess,
    persistent,
    permissionMode,
    model: activeModel,
    effort: activeEffort,
    onTitled,
  });
  // The transcript is read at switch/handoff time, not published per token —
  // publishing it on every token would re-render the world.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  /**
   * Move this thread to the other provider without leaving the pane. The turns
   * so far are carried and stamped, the transport is swapped, and the context
   * package lands in the composer — prefilled, never sent, so the user still
   * decides what the next provider is actually asked.
   */
  const switchProvider = useCallback(() => {
    const to = otherBackend(activeBackend);
    setCarried((prev) =>
      carryOver(
        prev,
        messagesRef.current,
        activeBackend,
        to,
        activeModel || null,
        `switch-${Date.now()}`,
        Date.now()
      )
    );
    const context = renderHandoffContext({
      from: activeBackend,
      to,
      cwd,
      turns: handoffTurnsFrom(messagesRef.current, activeBackend, activeModel || null),
    });
    useAgentStore.getState().setDraft(sessionId, context);
    setActiveBackend(to);
    // Both halves of the switch are one durable fact on this thread.
    void invoke("thread_timeline_append", {
      threadId: sessionId,
      kind: "providerSwitch",
      attribution: { provider: to, model: null, nativeThreadId: sessionId },
      payload: JSON.stringify({ from: activeBackend, to, inPlace: true }),
    }).catch(() => {});
  }, [activeBackend, activeModel, cwd, sessionId]);

  const [preview, setPreview] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only while the user is parked at the bottom: reading
  // scrollHeight forces layout of the whole transcript, and doing that per
  // token is what makes a long thread stutter.
  const pinnedRef = useRef(true);
  const scrollRaf = useRef<number | null>(null);

  // One object so the memoized rows below take a single stable prop for
  // everything a message action needs to know about its session.
  const chat = useMemo(
    () => ({
      sessionId,
      cwd,
      backend: activeBackend,
      model: activeModel || null,
      onSwitchProvider: switchProvider,
    }),
    [sessionId, cwd, activeBackend, activeModel, switchProvider]
  );
  const draft = useAgentStore((s) => s.drafts[sessionId]);
  const clearDraft = useAgentStore((s) => s.clearDraft);
  const consumeDraft = useCallback(
    () => clearDraft(sessionId),
    [clearDraft, sessionId]
  );

  const registerSender = useAgentStore((s) => s.registerSender);
  const unregisterSender = useAgentStore((s) => s.unregisterSender);
  // Expose this session's `send` so panels outside the pane (the slash-command
  // list) can run a command in the active chat.
  useEffect(() => {
    registerSender(sessionId, send);
    return () => unregisterSender(sessionId);
  }, [sessionId, send, registerSender, unregisterSender]);

  const registerTranscript = useAgentStore((s) => s.registerTranscript);
  const unregisterTranscript = useAgentStore((s) => s.unregisterTranscript);
  useEffect(() => {
    registerTranscript(sessionId, () =>
      handoffTurnsFrom(messagesRef.current, backend, activeModel || null)
    );
    return () => unregisterTranscript(sessionId);
  }, [sessionId, backend, activeModel, registerTranscript, unregisterTranscript]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // Stick to the bottom as messages stream in, and when this pane is revealed.
  // Hidden panes render nothing, so an rAF after reveal lets layout and syntax
  // highlighting settle before we jump to the end. One rAF stays in flight.
  useEffect(() => {
    if (!active || !pinnedRef.current || scrollRaf.current !== null) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [messages, active]);

  useEffect(
    () => () => {
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
    },
    []
  );

  const busy = status === "thinking" || status === "streaming" || status === "tool";
  // Both are dead ends for this session — `error` used to render nothing and
  // left the composer live with no agent behind it.
  const terminal = status === "exited" || status === "error";
  const accountIssue = useAgentStore((s) => s.accountIssue);

  // While a tool runs, say what it's doing instead of a generic "Running tool…".
  let statusLabel = STATUS_LABEL[status];
  if (active && status === "tool") {
    const running = messages[messages.length - 1]?.tools.find((t) => t.result == null);
    if (running) {
      const d = describeTool(running.name, running.input);
      statusLabel = d.title ? `${d.label} ${d.title}` : d.label;
    }
  }

  // Stable across renders so memoized rows don't re-render on every update.
  const openPreview = useCallback((dataUrl: string) => setPreview(dataUrl), []);

  // Everything earlier providers produced, then whatever the live transport
  // has now — one transcript, however many providers it took.
  const thread = useMemo(
    () => mergeThread(carried, messages, activeBackend, activeModel || null),
    [carried, messages, activeBackend, activeModel]
  );

  // Group the flat message list into turns so a finished turn's work (thinking,
  // tools, subagents) can collapse under one "Worked for Ns" header.
  const turns = useMemo(() => groupTurns(thread), [thread]);


  return (
    <div className="flex h-full w-full flex-col" style={{ fontFamily }}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="contain-layout contain-style flex-1 overflow-y-auto"
        style={{ fontSize: `${fontSize}px` }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
          <AgentOverview agentId={sessionId} active={active} />
          {/* Kept mounted even when hidden so switching is pure show/hide, not a
              transcript rebuild + re-highlight on every reveal. Isolated per-pane
              state and memoized rows keep a hidden pane from re-rendering on any
              render but its own stream. Auto-scroll stays gated on `active`. */}
          {thread.length === 0 && (
            <div className="mt-24 text-center text-sm text-muted-foreground">
              {ready ? "Send a message to start." : "Starting agent…"}
            </div>
          )}
          {turns.map((turn, i) => {
            const mark = switchBefore(carried, turn.key, thread);
            return (
              <Fragment key={turn.key}>
                {mark && <ProviderSwitchDivider mark={mark} />}
                <TurnRow
                  turn={turn}
                  live={busy && i === turns.length - 1}
                  fontSize={fontSize}
                  chat={chat}
                  onPreview={openPreview}
                />
              </Fragment>
            );
          })}
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
          {terminal &&
            (accountIssue ? (
              <AccountNotice issue={accountIssue} />
            ) : (
              <div className="mb-2 flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
                <div className="flex items-center justify-center gap-2">
                  <span>
                    {status === "error" ? "Session failed." : "Session ended."}
                  </span>
                  <button
                    type="button"
                    onClick={restart}
                    className="rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-secondary active:scale-97"
                  >
                    <RotateCw className="mr-1 inline size-3" />
                    Restart session
                  </button>
                </div>
                {exitReason && (
                  <span className="max-w-full truncate font-mono text-xs text-muted-foreground/80">
                    {exitReason}
                  </span>
                )}
              </div>
            ))}
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
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
                  backend={backend}
                  active={active}
                  ready={ready}
                  busy={busy}
                  queued={queued}
                  exited={terminal}
                  usage={usage}
                  model={activeModel}
                  onModelChange={changeModel}
                  effort={activeEffort}
                  onEffortChange={changeEffort}
                  fullAccess={fullAccess}
                  onFullAccessChange={setFullAccess}
                  queue={queue}
                  draft={draft}
                  onDraftConsumed={consumeDraft}
                  onSend={send}
                  onStop={stop}
                  onRewind={rewind}
                  onPreview={setPreview}
                />
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
});

/** A compact coordination surface. The conversation remains primary; this
 * card only makes parallel work visible and actionable from the chat thread. */
function AgentOverview({ agentId, active }: { agentId: string; active: boolean }) {
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const refresh = useCallback(async () => {
    const next = await invoke<RegistryAgent[]>("agent_list");
    setAgents(next);
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    let unlisten: (() => void) | undefined;
    void listen("agent-event", () => void refresh()).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, [active, refresh]);
  const others = agents.filter((agent) => agent.agentId !== agentId);
  if (agents.length === 0) return null;
  const delegate = async (target: RegistryAgent) => {
    const task = `Review the current work from ${agentId} and report concrete findings.`;
    await invoke("agent_delegate", { sourceAgentId: agentId, targetAgentId: target.agentId, task });
    await refresh();
  };
  return (
    <div className="rounded-lg border border-border/70 bg-secondary/20 px-3 py-2 text-xs">
      <div className="mb-2 flex items-center justify-between text-muted-foreground">
        <span className="font-medium text-foreground">Agent workspace</span>
        <span>{agents.length} active conversation{agents.length === 1 ? "" : "s"}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {agents.map((agent) => (
          <div key={agent.agentId} className="flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1">
            <span className={cn("size-1.5 rounded-full", agent.lifecycle === "working" ? "bg-amber-500" : agent.lifecycle === "failed" ? "bg-red-500" : "bg-emerald-500")} />
            <span>{agent.backend === "claude" ? "Claude" : "Codex"}</span>
            <span className="text-muted-foreground">{agent.lifecycle}</span>
          </div>
        ))}
      </div>
      {others.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {others.map((agent) => (
            <button key={agent.agentId} type="button" onClick={() => void delegate(agent)} className="rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
              Send to {agent.backend === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Why this session died, when it was the account rather than the work: the
 *  generic "Session ended" is indistinguishable from a clean exit. The action
 *  (logging back in) lives in the global banner, so this only explains. */
function AccountNotice({ issue }: { issue: AccountIssue }) {
  const limited = issue.kind === "rate_limit";
  const Icon = limited ? TriangleAlert : LogIn;
  const reset = resetLabel(issue);
  return (
    <div
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        limited
          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
          : "border-red-500/40 bg-red-500/10 text-red-300"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">{issueTitle(issue)}</div>
        <div className="mt-0.5 break-words opacity-80">{issue.message}</div>
        {reset && <div className="mt-0.5 opacity-70">{reset}</div>}
      </div>
    </div>
  );
}

interface Turn {
  key: string;
  user: ChatMessage | null;
  assistants: ChatMessage[];
}

/** Split the flat message list into turns: a user message and the assistant
 *  messages that answer it, up to the next user message. */
function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      cur = { key: m.id, user: m, assistants: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { key: m.id, user: null, assistants: [] };
        turns.push(cur);
      }
      cur.assistants.push(m);
    }
  }
  return turns;
}

const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const isAgentTool = (name: string): boolean => name === "Task" || name === "Agent";

/** One turn: the user bubble, then either the live work (streaming) or, once
 *  finished, a "Worked for Ns" accordion over the work with the final answer
 *  left visible below it. */
const TurnRow = memo(
  function TurnRow({
    turn,
    live,
    fontSize,
    chat,
    onPreview,
  }: {
    turn: Turn;
    live: boolean;
    fontSize: number;
    chat: ChatContext;
    onPreview: (dataUrl: string) => void;
  }) {
    const { user, assistants } = turn;
    const last = assistants[assistants.length - 1];
    const hasWork = assistants.some((a) => a.thinking || a.tools.length > 0);
    // Background subagents outlive the turn that spawned them, so the work
    // accordion must not collapse over them while they're still running.
    const agentToolIds = useMemo(
      () =>
        assistants.flatMap((a) =>
          a.tools.filter((t) => isAgentTool(t.name)).map((t) => t.id)
        ),
      [assistants]
    );
    const agentsRunning = useAgentStore((s) =>
      agentToolIds.reduce(
        (n, id) => n + (s.subagents[id] && !s.subagents[id].endedAt ? 1 : 0),
        0
      )
    );

    return (
      <>
        {user && (
          <MessageRow
            message={user}
            fontSize={fontSize}
            chat={chat}
            onPreview={onPreview}
          />
        )}
        {assistants.length > 0 &&
          (live || !hasWork ? (
            assistants.map((a) => (
              <MessageRow
                key={a.id}
                message={a}
                fontSize={fontSize}
                chat={chat}
                onPreview={onPreview}
              />
            ))
          ) : (
            <div className="flex flex-col gap-2">
              <WorkedAccordion
                durationMs={
                  last?.endedAt != null && assistants[0]?.startedAt != null
                    ? last.endedAt - assistants[0].startedAt
                    : undefined
                }
                agentsRunning={agentsRunning}
              >
                {assistants.map((a, i) => (
                  <div key={a.id} className="flex flex-col gap-2">
                    {a.thinking && <ThinkingBlock text={a.thinking} active={false} />}
                    {a.tools.length > 0 && <ToolList tools={a.tools} />}
                    {/* Only interstitial narration stays inside; the final
                        answer is shown below the accordion. */}
                    {i < assistants.length - 1 && a.text && (
                      <Markdown text={a.text} fontSize={fontSize} />
                    )}
                  </div>
                ))}
              </WorkedAccordion>
              {last?.text && (
                <div className="group relative flex flex-col gap-2">
                  <Markdown text={last.text} fontSize={fontSize} />
                  <MessageActions text={last.text} chat={chat} />
                </div>
              )}
            </div>
          ))}
      </>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.fontSize === b.fontSize &&
    a.chat === b.chat &&
    a.turn.user === b.turn.user &&
    a.turn.assistants.length === b.turn.assistants.length &&
    a.turn.assistants.every((m, i) => m === b.turn.assistants[i])
);

/** Collapsible "Worked for Ns" header over a turn's work. Collapsed by default,
 *  but stays open while the turn's subagents are still running — `null` means
 *  the user hasn't decided, so the running count does. */
function WorkedAccordion({
  durationMs,
  agentsRunning,
  children,
}: {
  durationMs?: number;
  agentsRunning: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? agentsRunning > 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className={cn(
          "flex items-center gap-1.5 text-xs transition-colors hover:text-foreground",
          agentsRunning > 0 ? "text-violet-400" : "text-muted-foreground"
        )}
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
        />
        {agentsRunning > 0 ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            {agentsRunning === 1 ? "1 agent running" : `${agentsRunning} agents running`}
          </>
        ) : durationMs != null ? (
          `Worked for ${formatDuration(durationMs)}`
        ) : (
          "Work log"
        )}
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-2 pt-2">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Tool cards for a message; agent/Task tools render their subagent inline. */
function ToolList({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="flex flex-col gap-1">
      {tools.map((t) =>
        isAgentTool(t.name) ? (
          <SubagentInline key={t.id} id={t.id} tool={t} />
        ) : (
          <ToolCard key={t.id} tool={t} />
        )
      )}
    </div>
  );
}

/** A subagent run rendered inline where it was dispatched — header plus a
 *  work log of its activity. Subscribes to its own run so only it re-renders.
 *  A running run tickers once a second to settle finished background runs. */
const SubagentInline = memo(function SubagentInline({
  id,
  tool,
}: {
  id: string;
  tool: ToolCall;
}) {
  const run = useAgentStore((s) => s.subagents[id]);
  const settle = useAgentStore((s) => s.settleSubagents);
  const [showAll, setShowAll] = useState(false);
  const running = run ? run.endedAt == null : false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => settle(), 1000);
    return () => window.clearInterval(t);
  }, [running, settle]);

  // Not tracked as a run (shouldn't happen) — fall back to a plain tool card.
  if (!run) return <ToolCard tool={tool} />;

  const LIMIT = 4;
  const shown = showAll ? run.activity : run.activity.slice(-LIMIT);

  return (
    <div className="rounded-lg border border-border/70 bg-card/40 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Bot className="size-3.5 shrink-0 text-violet-400" />
        <span className="font-medium text-foreground">Subagent task</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {run.subagentType ? `${run.subagentType}: ` : ""}
          {run.description}
        </span>
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-400" />
        ) : run.isError ? (
          <span className="shrink-0 text-red-400">error</span>
        ) : (
          <Check className="size-3.5 shrink-0 text-emerald-400" />
        )}
      </div>
      {run.activity.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-l border-border/60 pl-2.5 text-muted-foreground">
          {run.activity.length > LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="self-start text-[11px] transition-colors hover:text-foreground"
            >
              {showAll
                ? "Show fewer log entries"
                : `Show ${run.activity.length - LIMIT} more`}
            </button>
          )}
          {shown.map((a, i) => {
            const Icon = a.icon ? TOOL_ICONS[a.icon] : null;
            return (
              <div key={i} className="flex items-center gap-1.5">
                {Icon ? (
                  <Icon className="size-3 shrink-0 opacity-70" />
                ) : (
                  <span className="size-1 shrink-0 rounded-full bg-current opacity-50" />
                )}
                <span className="min-w-0 truncate">{a.detail || a.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

/** Memoized: while a message is streaming only its own row re-renders, and
 *  typing in the composer re-renders none of them. */
const MessageRow = memo(function MessageRow({
  message,
  fontSize,
  chat,
  onPreview,
}: {
  message: ChatMessage;
  fontSize: number;
  chat: ChatContext;
  onPreview: (dataUrl: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1.5">
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
        {message.checkpointId && (
          <RevertTurnButton
            projectPath={chat.cwd}
            threadId={chat.sessionId}
            checkpointId={message.checkpointId}
          />
        )}
      </div>
    );
  }
  return (
    <div className="group relative flex flex-col gap-2">
      {message.thinking && (
        <ThinkingBlock
          text={message.thinking}
          active={message.streaming && !message.text && message.tools.length === 0}
        />
      )}
      {message.tools.length > 0 && <ToolList tools={message.tools} />}
      {message.text && (
        <Markdown text={message.text} fontSize={fontSize} streaming={message.streaming} />
      )}
      {message.text && !message.streaming && (
        <MessageActions text={message.text} chat={chat} />
      )}
    </div>
  );
});

/** What a message action needs about the chat it was rendered in. */
interface ChatContext {
  sessionId: string;
  cwd: string;
  backend: AgentBackend;
  /** The model this pane is running, for turn attribution in a handoff. */
  model: string | null;
  /** Continue this same thread on the other provider, in this pane. */
  onSwitchProvider: () => void;
}

/** Where the thread changed hands. Rendered in the transcript rather than as a
 *  toast, because which provider wrote which turn is part of reading it back. */
function ProviderSwitchDivider({ mark }: { mark: ProviderSwitchMark }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <ArrowRightLeft className="size-3" />
        {`${PROVIDER_LABEL[mark.from]} → ${PROVIDER_LABEL[mark.to]}`}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** The hover strip under an assistant message. Stays visible while the handoff
 *  menu is open — the pointer has left the message by then. */
function MessageActions({ text, chat }: { text: string; chat: ChatContext }) {
  return (
    <div className="absolute left-0 top-full flex w-fit items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 has-data-[state=open]:opacity-100">
      <CopyButton text={text} />
      <HandoffButton text={text} chat={chat} />
    </div>
  );
}

const actionClass =
  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={copy} title="Copy message" className={actionClass}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Send this message to the other backend's chat. The working tree is only
 *  inspected once the menu is open, so a transcript of these costs nothing. */
function HandoffButton({ text, chat }: { text: string; chat: ChatContext }) {
  const [open, setOpen] = useState(false);
  const changes = useGitChanges(chat.cwd, open);
  const dirty = (changes.data ?? []).length > 0;
  const label = handoffLabel(chat.backend);
  const hand = (withDiff: boolean) => {
    const store = useAgentStore.getState();
    const turns = store.transcripts[chat.sessionId]?.() ?? [];
    store.handoff?.({
      sourceSessionId: chat.sessionId,
      // The clicked message is the point of the handoff, so it travels even
      // when it sits further back than the turn limit.
      turns: withFocusedTurn(turns, {
        role: "assistant",
        provider: chat.backend,
        model: chat.model,
        text,
      }),
      withDiff,
    });
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className={actionClass}>
        <ArrowRightLeft className="size-3.5" />
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {/* Same thread, other provider: the turns so far stay in this
            transcript, attributed to whoever produced them. */}
        <DropdownMenuItem onSelect={chat.onSwitchProvider}>
          {`Continue here with ${BACKEND_LABEL[otherBackend(chat.backend)]}`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => hand(false)}>{label}</DropdownMenuItem>
        {dirty && (
          <DropdownMenuItem onSelect={() => hand(true)}>
            {`${label} with changes`}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Reasoning, kept out of the way: a borderless dashed strip rather than a
 *  card, so it never reads as a tool call. Opens live while the model is
 *  thinking and closes once it moves on — until the user clicks, then their
 *  choice sticks. */
function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-1.5 italic hover:text-foreground"
      >
        <Brain className={cn("size-3.5 shrink-0 opacity-70", active && "animate-pulse")} />
        {active ? "Thinking…" : "Thought for a moment"}
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

const TODO_MARK: Record<TodoItem["status"], { mark: string; className: string }> = {
  completed: { mark: "✓", className: "text-emerald-400 line-through opacity-60" },
  in_progress: { mark: "▸", className: "text-primary" },
  pending: { mark: "○", className: "text-muted-foreground" },
};

/** Old vs new for an Edit, as a syntax-highlighted unified diff. */
const ToolDiff = memo(function ToolDiff({
  before,
  after,
  lang,
}: {
  before: string;
  after: string;
  lang: string | null;
}) {
  const rows = useMemo(
    () =>
      diffLines(before, after).flatMap((part, i) =>
        part.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, j) => ({
            key: `${i}-${j}`,
            sign: part.added ? "+" : part.removed ? "-" : " ",
            tint: part.added
              ? "border-emerald-500/50 bg-emerald-500/15"
              : part.removed
                ? "border-red-500/50 bg-red-500/15"
                : "border-transparent",
            html: highlightCached(line, lang),
          }))
      ),
    [before, after, lang]
  );
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre font-mono text-[0.7rem] leading-relaxed">
      <div className="w-max min-w-full">
        {rows.map((row) => (
          <div key={row.key} className={cn("flex gap-2 border-l-2 px-1", row.tint)}>
            <span className="select-none text-muted-foreground">{row.sign}</span>
            <code
              className="hljs"
              style={{ background: "transparent", padding: 0 }}
              dangerouslySetInnerHTML={{ __html: row.html }}
            />
          </div>
        ))}
      </div>
    </pre>
  );
});

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

const ToolCard = memo(function ToolCard({ tool }: { tool: ToolCall }) {
  // Both parses are expensive — describeResult regexes and re-serialises
  // results that are routinely tens of KB — and neither depends on render.
  const display = useMemo(() => describeTool(tool.name, tool.input), [tool.name, tool.input]);
  const resultParts = useMemo(
    () => (tool.result != null ? describeResult(stripReminders(tool.result)) : null),
    [tool.result]
  );
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

  // An agent card is a doorway to the side panel — clicking it selects the run
  // there rather than expanding a body inline. Everything else toggles inline.
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const selectedAgent = useAgentStore((s) => s.selectedAgent);
  const selected = isAgent && selectedAgent === tool.id;
  const clickable = isAgent || expandable;

  // A collapsed body would still pay full diff + highlight cost, so it is only
  // mounted while open — kept alive until the collapse transition finishes so
  // the card still animates shut.
  // Mounted during render, not in an effect, so the body exists in the same
  // commit that grows the grid row — otherwise opening snaps instead of gliding.
  const [bodyMounted, setBodyMounted] = useState(open);
  if (open && !bodyMounted) setBodyMounted(true);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/50 text-xs">
      <button
        type="button"
        onClick={() =>
          isAgent
            ? selectAgent(selected ? null : tool.id)
            : expandable && setOverride(!open)
        }
        disabled={!clickable}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
          clickable && "hover:bg-muted/40",
          selected && "bg-primary/10"
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
          {expandable && !isAgent && (
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
        onTransitionEnd={(e) => {
          if (!open && e.propertyName === "grid-template-rows") setBodyMounted(false);
        }}
      >
        <div className="overflow-hidden">
          {bodyMounted && (
            <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
              {display.body.map((part, idx) => (
                <ToolBody key={idx} part={part} />
              ))}
              {resultParts?.map((part, idx) => (
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
          )}
        </div>
      </div>
    </div>
  );
});

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

const ToolCode = memo(function ToolCode({
  code,
  lang,
  className,
}: {
  code: string;
  lang: string | null;
  className?: string;
}) {
  const html = useMemo(() => highlightCached(code, lang), [code, lang]);
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
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
});

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

/** Put the working tree back to just before this turn ran. Shows what it will
 *  touch first — a revert that silently deletes a file the user wrote by hand
 *  is not something to find out about afterwards. */
function RevertTurnButton({
  projectPath,
  threadId,
  checkpointId,
}: {
  projectPath: string;
  threadId: string;
  checkpointId: string;
}) {
  const [busy, setBusy] = useState(false);
  const invalidateGit = useInvalidateGit();

  const revert = async () => {
    setBusy(true);
    try {
      const changes = await checkpointChanges(projectPath, checkpointId);
      if (changes.length === 0) {
        toast.info("Nothing to revert", {
          description: "The working tree is unchanged since this turn.",
        });
        return;
      }
      const added = changes.filter((c) => c.kind === "added");
      const ok = await ask(
        `${describeRestore(changes)}.\n\nRestore the working tree to before this turn?`,
        { title: "Revert turn", kind: "warning" }
      );
      if (!ok) return;
      // Deleting files created since the checkpoint is a second, separate ask:
      // some of them are the agent's, some may be the user's own.
      const removeAdded =
        added.length > 0 &&
        (await ask(
          `Also delete ${added.length} file(s) created since this turn?\n\n${added
            .slice(0, 8)
            .map((c) => c.path)
            .join("\n")}`,
          { title: "Delete new files", kind: "warning" }
        ));
      await restoreCheckpoint(projectPath, checkpointId, removeAdded);
      invalidateGit(projectPath);
      // A revert is a durable fact about the thread, not just a toast.
      void invoke("thread_timeline_append", {
        threadId,
        kind: "checkpointReverted",
        attribution: null,
        payload: JSON.stringify({ checkpointId, removeAdded, changes: changes.length }),
      }).catch(() => {});
      toast.success("Reverted to before this turn");
    } catch (e) {
      toast.error("Revert failed", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void revert()}
      disabled={busy}
      title="Restore the working tree to before this turn"
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground group-hover:opacity-100 disabled:opacity-40"
    >
      <Undo2 className="size-3.5" />
      Revert turn
    </button>
  );
}
