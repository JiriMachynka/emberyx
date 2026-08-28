import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRightLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ListTodo,
  Loader2,
  LogIn,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { issueTitle, resetLabel, type AccountIssue } from "@/lib/accountState";
import { basename } from "@/lib/path";
import { Button } from "@/components/ui/button";
import { FileRefProject, TextWithFileRefs } from "@/components/FileRef";
import { BACKEND_LABEL, type AgentBackend } from "@/lib/agentBackend";
import {
  describeTool,
  isTodoTool,
  lastTodos,
  type TodoItem,
} from "@/lib/toolDisplay";
import { TOOL_ICONS } from "@/lib/toolIcons";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  anchorCorrection,
  isPinnedAtBottom,
  nextPinState,
  showLoadOlder,
  type PrependAnchor,
} from "@/lib/chatVirtual";
import { useChatSession } from "@/hooks/useChatSession";
import {
  type ChatImage,
  type ChatMessage,
  type ChatStatus,
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
import type { PermissionMode, Settings } from "@/lib/settings";
import { launchFor } from "@/lib/settings";
import { getThreadMeta, setThreadMeta, threadMetaKey } from "@/lib/threadMeta";
import { lastActivityAt } from "@/lib/compact";
import { ThreadLinkProvider } from "@/components/PrLink";
import type { Project } from "@/types";
import { projectLabel } from "@/lib/worktree";
import { PROVIDER_LABEL } from "@/lib/providers";
import { useGitChanges } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";
import { formatDuration, groupTurns, isAgentTool, type Turn } from "@/components/chat/turns";
import { ToolCard } from "@/components/chat/ToolViews";
import { AskPrompt, PermissionPrompt } from "@/components/chat/Prompts";

/** Reconstruct a data: URL for rendering from a stored ChatImage. */
const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;

interface ChatPaneProps {
  sessionId: string;
  cwd: string;
  resume?: string;
  /** Agent CLI this chat drives; gates the Claude-only composer surfaces. */
  backend: AgentBackend;
  active: boolean;
  /** Chat + composer font stack; the terminal's is separate. */
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
  /** Per-backend launch overrides; the active backend's is resolved here. */
  providerLaunch: Settings["providerLaunch"];
  /** Extra named Claude setups, shown in the composer when any exist. */
  claudeProfiles: Settings["claudeProfiles"];
  /** Codex sandbox posture; "" derives it from the permission switches. */
  codexSandbox: Settings["codexSandbox"];
  /** Projects available to the empty-thread project switcher. */
  projects: Project[];
  recentProjects: string[];
  onSelectProject: (projectId: string) => void;
  onOpenProject: (path: string) => void;
  onTitled?: (title: string) => void;
  /** A fresh chat has named its thread and been given a first message. Fires
   *  once, so the sidebar lists the thread before its transcript exists. */
  onThreadStarted?: (threadId: string, firstMessage: string) => void;
}

/** How close to the top counts as "show me the previous page". */
const LOAD_EARLIER_PX = 600;

/** Pages the scroll position may pull in before the button takes over. */
const AUTO_LOAD_PAGES = 3;

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
  providerLaunch,
  claudeProfiles,
  codexSandbox,
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
  onTitled,
  onThreadStarted,
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
  const [claudeProfileId, setClaudeProfileId] = useState<string | null>(() =>
    resume
      ? getThreadMeta(threadMetaKey(cwd, resume)).claudeProfileId ?? null
      : null
  );
  // The active backend's launch override, memoized so its identity survives
  // renders — it rides the transport hooks' spawn-effect deps.
  const launch = useMemo(
    () =>
      launchFor({ providerLaunch, claudeProfiles }, activeBackend, claudeProfileId),
    [providerLaunch, claudeProfiles, activeBackend, claudeProfileId]
  );
  const [carried, setCarried] = useState<CarriedThread>(EMPTY_THREAD);
  const { 
    messages,
    status,
    usage,
    ready,
    threadId,
    send,
    compact,
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
    hasMore,
    loadingOlder,
    loadOlder,
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
    launch,
    codexSandbox,
    onTitled,
  });
  // Register a fresh thread with the sidebar the moment it has both an id and a
  // first message. Without this the row only appears once the turn ends and the
  // transcript scan finds it on disk — a thread you are already talking to is
  // missing from the list for the whole first turn. The message stands in as the
  // title until the real one is generated.
  const startedRef = useRef(false);
  const firstUserMessage = messages.find((m) => m.role === "user")?.text;
  useEffect(() => {
    if (startedRef.current || resume || !threadId || !firstUserMessage) return;
    startedRef.current = true;
    onThreadStarted?.(threadId, firstUserMessage);
  }, [resume, threadId, firstUserMessage, onThreadStarted]);

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
  const switchProvider = useCallback(
    (to: AgentBackend, prefill: boolean) => {
    if (to === activeBackend) return;
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
    if (prefill) {
      const context = renderHandoffContext({
        from: activeBackend,
        to,
        cwd,
        turns: handoffTurnsFrom(messagesRef.current, activeBackend, activeModel || null),
      });
      useAgentStore.getState().setDraft(sessionId, context);
    }
    setActiveBackend(to);
    // Both halves of the switch are one durable fact on this thread.
    void invoke("thread_timeline_append", {
      threadId: sessionId,
      kind: "providerSwitch",
      attribution: { provider: to, model: null, nativeThreadId: sessionId },
      payload: JSON.stringify({ from: activeBackend, to, inPlace: true }),
    }).catch(() => {});
    },
    [activeBackend, activeModel, cwd, sessionId]
  );

  const [preview, setPreview] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Prepend anchor: which virtual row owned the top of the viewport and how far
  // down it sat. After older pages commit, putting that row back at the same
  // offset keeps the view pixel-fixed (see chatVirtual.anchorCorrection).
  const prependAnchorRef = useRef<PrependAnchor | null>(null);
  const settleRaf = useRef<number | null>(null);
  // Auto-scroll only while the user is parked at the bottom: reading
  // scrollHeight forces layout of the whole transcript, and doing that per
  // token is what makes a long thread stutter.
  const pinnedRef = useRef(true);
  const userScrollRef = useRef(false);
  const scrollRaf = useRef<number | null>(null);
  const [showScrollEnd, setShowScrollEnd] = useState(false);

  // One object so the memoized rows below take a single stable prop for
  // everything a message action needs to know about its session.
  const chat = useMemo(
    () => ({
      sessionId,
      cwd,
      backend: activeBackend,
      model: activeModel || null,
      onSwitchProvider: () => switchProvider(otherBackend(activeBackend), true),
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
    // Consumed per scroll event: one gesture unpins once, and the measurement
    // corrections that follow it can't re-decide what the user meant.
    const userDriven = userScrollRef.current;
    userScrollRef.current = false;
    const pinned = nextPinState({
      pinned: pinnedRef.current,
      atBottom: isPinnedAtBottom(el.scrollHeight, el.scrollTop, el.clientHeight),
      userDriven,
    });
    pinnedRef.current = pinned;
    setShowScrollEnd(!pinned);
    // Reaching the top loads the previous page itself. A thread runs to
    // hundreds of messages and the window is 60, so clicking a button per page
    // is the difference between "the history is there" and "the history is
    // gone". `loadOlder` no-ops while a page is already in flight.
    if (el.scrollTop < LOAD_EARLIER_PX) autoLoadRef.current();
  }, []);

  // Which scrolls came from the user. Virtualized rows re-measure after paint
  // and each correction fires a scroll event, so geometry alone can't tell a
  // drag from the pane settling into place.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = () => {
      userScrollRef.current = true;
    };
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("mousedown", mark);
    el.addEventListener("keydown", mark);
    return () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("mousedown", mark);
      el.removeEventListener("keydown", mark);
    };
  }, []);

  // A different thread in the same pane starts at its end, like a freshly
  // opened one — the previous thread's scroll position says nothing about it.
  useEffect(() => {
    pinnedRef.current = true;
    userScrollRef.current = false;
    setShowScrollEnd(false);
  }, [sessionId]);

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowScrollEnd(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
      if (settleRaf.current !== null) cancelAnimationFrame(settleRaf.current);
    },
    []
  );

  // A resumed thread keeps growing after the one-shot jump above — Shiki
  // colors fences in ~80ms late and images size on load — so a single scroll
  // lands mid-thread. While pinned, follow every content resize instead. The
  // observer fires after layout, so reading scrollHeight here is not a forced
  // reflow.
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [active]);

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

  // The scroll stream as virtual slots: optional load-earlier bookend, one
  // entry per turn (its provider-switch divider travels with it), and the
  // busy footer. Keys are stable across prepends, which is what lets the
  // virtualizer reuse measured heights for already-seen rows.
  type Slot =
    | { key: string; kind: "load" }
    | {
        key: string;
        kind: "turn";
        turn: (typeof turns)[number];
        mark: ProviderSwitchMark | null;
      }
    | { key: string; kind: "busy" };
  const slots = useMemo<Slot[]>(() => {
    const list: Slot[] = [];
    if (showLoadOlder(hasMore)) list.push({ key: "load", kind: "load" });
    for (const turn of turns) {
      list.push({
        key: `turn:${turn.key}`,
        kind: "turn",
        turn,
        mark: switchBefore(carried, turn.key, thread),
      });
    }
    if (busy) list.push({ key: "busy", kind: "busy" });
    return list;
  }, [turns, hasMore, busy, carried, thread]);

  // Read by the prepend settle loop below, which runs off rAF and so cannot
  // close over the render's `slots`.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  // The busy footer is a slot of its own, so the last slot is not the last
  // turn — the streaming turn is the one before it.
  const lastTurnIndex = useMemo(() => {
    for (let i = slots.length - 1; i >= 0; i -= 1) {
      if (slots[i].kind === "turn") return i;
    }
    return -1;
  }, [slots]);

  const rowVirt = useVirtualizer({
    count: slots.length,
    getScrollElement: () => scrollRef.current,
    // Turns dominate; a rough midpoint is fine — measureElement corrects.
    estimateSize: (index) => (slots[index]?.kind === "turn" ? 340 : 52),
    getItemKey: (index) => slots[index]?.key ?? String(index),
    overscan: 6,
  });

  // Read by `onScroll`, which is created before `loadEarlier` and must stay
  // identity-stable — a scroll handler that changes identity per page re-binds
  // mid-gesture.
  const autoLoadRef = useRef<() => void>(() => {});
  // Auto-loading is a convenience for the recent past, not a way to page an
  // 800-message thread into memory by resting at the top: each page mounts 60
  // more messages and their highlighted code. After this many the button comes
  // back and the user asks for the rest deliberately.
  const autoLoadsLeftRef = useRef(AUTO_LOAD_PAGES);


  const loadEarlier = useCallback(() => {
    if (!hasMore) return;
    const el = scrollRef.current;
    // Anchor on the first turn, not the first row: the load bookend keeps
    // index 0 and start 0 across a prepend, so holding *it* still would pin
    // the view to the top instead of to the content the user was reading.
    const first = rowVirt
      .getVirtualItems()
      .find((item) => slots[item.index]?.kind === "turn");
    prependAnchorRef.current =
      el && first
        ? { key: String(first.key), offsetInView: first.start - el.scrollTop }
        : null;
    void loadOlder().then((did) => {
      if (!did) prependAnchorRef.current = null;
    });
  }, [hasMore, loadOlder, rowVirt, slots]);

  // The scroll path spends a budget; the button never does.
  const autoLoad = useCallback(() => {
    if (autoLoadsLeftRef.current <= 0) return;
    autoLoadsLeftRef.current -= 1;
    loadEarlier();
  }, [loadEarlier]);
  autoLoadRef.current = autoLoad;

  // Prepended rows arrive at their estimate and only reach their real height
  // once the ResizeObserver has seen them, so a single correction is computed
  // from fiction. Re-anchor every frame until the watched row's start holds.
  const settlePrepend = useCallback(() => {
    settleRaf.current = null;
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (!el || !anchor) {
      prependAnchorRef.current = null;
      return;
    }
    // Re-runs the measurement pass, so `measurementsCache` below reflects
    // whatever landed since the last render rather than that render's guess.
    rowVirt.getTotalSize();
    const index = slotsRef.current.findIndex((slot) => slot.key === anchor.key);
    const start = index < 0 ? null : rowVirt.measurementsCache[index]?.start ?? null;
    const correction = anchorCorrection(anchor, start);
    prependAnchorRef.current = correction?.next ?? null;
    if (correction) el.scrollTop = correction.scrollTop;
    if (prependAnchorRef.current) {
      settleRaf.current = requestAnimationFrame(settlePrepend);
    }
  }, [rowVirt]);

  useLayoutEffect(() => {
    // First pass runs before paint, so the prepend never shows its jump.
    if (prependAnchorRef.current && settleRaf.current === null) settlePrepend();
  }, [thread, settlePrepend]);

  // Latest plan for the in-flight turn — pinned above the composer like T3,
  // not buried in a generic tool card.
  const liveTodos = useMemo(() => {
    if (!busy) return null;
    const turn = turns[turns.length - 1];
    return turn ? lastTodos(turn.assistants.flatMap((a) => a.tools)) : null;
  }, [busy, turns]);
  const todosSig = liveTodos?.map((t) => `${t.status}\0${t.text}`).join("\n") ?? "";
  const [tasksHidden, setTasksHidden] = useState(false);
  useEffect(() => setTasksHidden(false), [todosSig]);

  const openProjectPaths = new Set(projects.map((project) => project.path));
  const recentOnly = recentProjects.filter(
    (path) => !openProjectPaths.has(path)
  );
  const newThreadHeading = (
    <h2 className="text-center text-3xl font-normal tracking-tight text-foreground">
      {ready ? (
        <>
          What should we build in{" "}
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center gap-1 underline decoration-border underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:rounded focus-visible:ring-1 focus-visible:ring-ring">
              {basename(cwd)}
              <ChevronDown className="size-4 no-underline opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              {projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  disabled={project.path === cwd}
                  onSelect={() => onSelectProject(project.id)}
                >
                  {projectLabel(project)}
                </DropdownMenuItem>
              ))}
              {recentOnly.length > 0 && projects.length > 0 && (
                <DropdownMenuSeparator />
              )}
              {recentOnly.map((path) => (
                <DropdownMenuItem
                  key={path}
                  onSelect={() => onOpenProject(path)}
                  title={path}
                >
                  {basename(path)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          ?
        </>
      ) : (
        "Starting agent…"
      )}
    </h2>
  );


  return (
    <FileRefProject value={cwd}>
    <ThreadLinkProvider
      value={
        resume ? { projectPath: cwd, threadId: resume } : null
      }
    >
    <div
      className="chat-pane relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      style={{ fontFamily }}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="contain-layout contain-style absolute inset-0 min-h-0 overflow-y-auto overscroll-contain"
        style={{ fontSize: `${fontSize}px` }}
      >
        {/* Padding stays outside the sized box: folding it in would put the
            bottom gutter *inside* getTotalSize() and leave the last turn ending
            flush with the scroll end, hidden under the composer. */}
        <div className="mx-auto min-h-full w-full max-w-3xl px-5 pb-64 pt-10">
          <div className="relative w-full" style={{ height: rowVirt.getTotalSize() }}>
            {rowVirt.getVirtualItems().map((vItem) => {
              const slot = slots[vItem.index];
              if (!slot) return null;
              return (
                <div
                  key={slot.key}
                  // measureElement resolves the row by data-index; without it
                  // nothing is ever measured and every row keeps its estimate.
                  data-index={vItem.index}
                  data-vkey={slot.key}
                  ref={rowVirt.measureElement}
                  className="absolute inset-x-0 will-change-transform"
                  style={{ transform: `translateY(${vItem.start}px)` }}
                >
                  <div className="chat-content-width mx-auto flex flex-col gap-8 pt-8">
                    {slot.kind === "load" && (
                      <div className="flex justify-center">
                        <button
                          type="button"
                          disabled={loadingOlder}
                          onClick={loadEarlier}
                          className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                          {loadingOlder ? "Loading…" : "Load earlier messages"}
                        </button>
                      </div>
                    )}
                    {slot.kind === "turn" && (
                      <Fragment>
                        {slot.mark && <ProviderSwitchDivider mark={slot.mark} />}
                        <TurnRow
                          turn={slot.turn}
                          live={busy && vItem.index === lastTurnIndex}
                          fontSize={fontSize}
                          chat={chat}
                          onPreview={openPreview}
                        />
                      </Fragment>
                    )}
                    {slot.kind === "busy" && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        <span className="min-w-0 truncate">{statusLabel}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {showScrollEnd && (
          <button
            type="button"
            onClick={scrollToEnd}
            className="absolute bottom-52 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
          >
            <ChevronDown className="size-3.5" />
            Scroll to end
          </button>
        )}
      </div>

      <div
        className={cn(
          "absolute inset-x-0 z-10 shrink-0 px-5 pb-5 pt-3",
          thread.length === 0
            ? "top-1/2 -translate-y-1/2"
            : "bottom-0"
        )}
      >
        <div className="chat-content-width mx-auto">
          {thread.length === 0 && <div className="mb-8">{newThreadHeading}</div>}
          {terminal &&
            (accountIssue ? (
              <AccountNotice issue={accountIssue} />
            ) : (
              <div className="mb-2 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-center gap-3">
                  <span>
                    {status === "error" ? "Session failed." : "Session ended."}
                  </span>
                  <Button variant="outline" onClick={restart}>
                    <RotateCw />
                    Restart session
                  </Button>
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
                <>
                  {liveTodos && !tasksHidden && (
                    <div className="mb-3">
                      <TasksCard
                        items={liveTodos}
                        onDismiss={() => setTasksHidden(true)}
                      />
                    </div>
                  )}
                <ChatComposer
                  cwd={cwd}
                  backend={activeBackend}
                  active={active}
                  fontFamily={fontFamily}
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
                  onSwitchBackend={(to) => switchProvider(to, false)}
                  claudeProfiles={claudeProfiles}
                  claudeProfileId={claudeProfileId}
                  onClaudeProfileChange={(id) => {
                    setClaudeProfileId(id);
                    if (resume) {
                      setThreadMeta(threadMetaKey(cwd, resume), {
                        claudeProfileId: id ?? undefined,
                      });
                    }
                  }}
                  queue={queue}
                  draft={draft}
                  onDraftConsumed={consumeDraft}
                  onSend={send}
                  onCompact={compact}
                  lastActivityAt={lastActivityAt(messages)}
                  onStop={stop}
                  onRewind={rewind}
                  onPreview={setPreview}
                />
                </>
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
    </ThreadLinkProvider>
    </FileRefProject>
  );
});

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

/** Elapsed time per todo text, captured at status transitions so the card
 *  can show "2m 35s" / "now" without the tool payload carrying clocks. */
const useTodoTimings = (items: TodoItem[]) => {
  const timings = useRef(new Map<string, { startedAt: number; endedAt?: number }>());
  const now = Date.now();
  for (const item of items) {
    const prev = timings.current.get(item.text);
    if (item.status === "in_progress") {
      if (!prev || prev.endedAt != null) {
        timings.current.set(item.text, { startedAt: now });
      }
    } else if (item.status === "completed" && prev && prev.endedAt == null) {
      timings.current.set(item.text, { startedAt: prev.startedAt, endedAt: now });
    }
  }
  return timings.current;
};

const TasksCard = memo(function TasksCard({
  items,
  onDismiss,
}: {
  items: TodoItem[];
  onDismiss?: () => void;
}) {
  const timings = useTodoTimings(items);
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <div className="rounded-xl border border-border bg-card/70">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <ListTodo className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">
          Tasks {done}/{items.length}
        </span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            aria-label="Dismiss tasks"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <ul className="flex flex-col px-3 pb-2">
        {items.map((item, i) => {
          const t = timings.get(item.text);
          const elapsed =
            item.status === "in_progress"
              ? "now"
              : item.status === "completed" && t?.endedAt != null
                ? formatDuration(t.endedAt - t.startedAt)
                : undefined;
          return (
            <li key={`${i}:${item.text}`} className="flex items-start gap-2 py-1.5 text-sm">
              {item.status === "completed" ? (
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : item.status === "in_progress" ? (
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              ) : (
                <span className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/40" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1",
                  item.status === "completed" && "text-muted-foreground",
                )}
              >
                {item.text}
              </span>
              {elapsed && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {elapsed}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
});

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
    const turnTodos = lastTodos(assistants.flatMap((a) => a.tools));
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
            /* The turn's siblings sit in the scroll column's `gap-8`, which is
               the spacing between turns — applied to a run of tool cards it
               puts 32px between every Bash call. One assistant message per
               tool is the norm, so the live work is its own tight column. */
            <div className="flex flex-col gap-2">
              {assistants.map((a) => (
                <MessageRow
                  key={a.id}
                  message={a}
                  fontSize={fontSize}
                  chat={chat}
                  onPreview={onPreview}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {turnTodos && <TasksCard items={turnTodos} />}
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

/** Tool cards for a message; agent/Task tools render their subagent inline.
 *  TodoWrite is lifted into TasksCard so it isn't a generic tool row. */
function ToolList({ tools }: { tools: ToolCall[] }) {
  const rest = tools.filter((t) => !isTodoTool(t.name));
  if (rest.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {rest.map((t) =>
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
    <div className="relative rounded-lg">
    <div className="rounded-lg border border-border/70 bg-card/40 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Bot className="size-3.5 shrink-0 text-violet-400" />
        <span
          className={cn(
            "font-medium",
            running ? "tool-running-label" : "text-foreground"
          )}
        >
          Subagent task
        </span>
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
          <div className="chat-bubble max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5">
            <TextWithFileRefs text={message.text} />
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
      {message.tools.length > 0 && (
        <ToolList tools={message.tools} />
      )}
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
      {chat.backend !== "claude" && <HandoffButton text={text} chat={chat} />}
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


/** Old vs new for an Edit, as a syntax-highlighted unified diff. */
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
