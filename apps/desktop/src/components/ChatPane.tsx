import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronDown,
  Folder,
  Gauge,
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
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { Button } from "@/components/ui/button";
import { FileRefProject, TextWithFileRefs } from "@/components/FileRef";
import { BACKEND_LABEL, capabilitiesOf, type AgentBackend } from "@/lib/agentBackend";
import {
  currentTodo,
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
import { MarkdownAsync as Markdown } from "@/components/MarkdownAsync";
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
  switchMarks,
  type CarriedThread,
  type ProviderSwitchMark,
} from "@/lib/thread";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FileDiff, Undo2 } from "lucide-react";
import { quotaAlert, quotaMessage, type QuotaAlert } from "@/lib/quota";
import { recordTodoTimings, todoTimings } from "@/lib/todoTimings";
import { summarizeWork } from "@/lib/workSummary";
import { useInvalidateGit } from "@/lib/queries";
import {
  checkpointChanges,
  describeRestore,
  restoreCheckpoint,
  sumRangeFiles,
} from "@/lib/checkpoints";
import {
  accessLevelFrom,
  accessLevelToSettings,
  type AccessLevel,
  type PermissionMode,
  type Settings,
} from "@/lib/settings";
import { launchFor } from "@/lib/settings";
import { getThreadMeta, setThreadMeta, threadMetaKey } from "@/lib/threadMeta";
import { lastActivityAt } from "@/lib/compact";
import { ThreadLinkProvider } from "@/components/PrLink";
import { PaneVisibleProvider, usePaneVisible } from "@/components/chat/PaneVisible";
import type { Project } from "@/types";
import { projectLabel } from "@/lib/worktree";
import { PROVIDER_LABEL } from "@/lib/providers";
import { useGitChanges, useTurnFiles } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import { rememberRowSizes, rowSize } from "@/lib/rowSizes";
import { buildTree, dirTotals } from "@/lib/fileTree";
import { cn } from "@/lib/utils";
import { buildActivityRow, kindForToolName } from "@/lib/activities";
import { modelFitsBackend } from "@/lib/modelCatalog";
import { getCustomModels } from "@/lib/modelFavorites";
import { formatDuration, groupTurns, isAgentTool, type Turn } from "@/components/chat/turns";
import { ActivityList } from "@/components/chat/ActivityRow";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { ToolCard } from "@/components/chat/ToolViews";
import { AskPrompt, PermissionPrompt } from "@/components/chat/Prompts";
import { useRunningTimer } from "@/hooks/useRunningTimer";

/** Reconstruct a data: URL for rendering from a stored ChatImage. */

/** The turn clock sits under the transcript, not on each tool card — and on
 *  the left, where the transcript's own text starts, rather than centred under
 *  it. Travelling dots carry the "still going" signal so the line reads as
 *  live at a glance, without a second look at the seconds. */
function WorkingFooter({
  turnKey,
  busy,
}: {
  turnKey: string | undefined;
  busy: boolean;
}) {
  const label = useRunningTimer(turnKey, busy);
  if (!label) return null;
  return (
    <div className="relative z-10 mb-2 flex items-center gap-2 px-1 text-xs">
      <span aria-hidden className="working-dots flex items-center gap-1">
        <span className="size-1 rounded-full bg-muted-foreground" />
        <span className="size-1 rounded-full bg-muted-foreground" />
        <span className="size-1 rounded-full bg-muted-foreground" />
      </span>
      {/* Same "this is live work" signal as a running tool row, not a new one. */}
      <span className="tool-running-label">{label}</span>
    </div>
  );
}

const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;

interface ChatPaneProps {
  sessionId: string;
  cwd: string;
  resume?: string;
  /** The thread is imported history — rendered from the local event log, with
   *  no provider session behind it to continue. */
  imported?: boolean;
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
  /** Persist a new default backend when the picker moves a chat to another
   *  provider — the stored model/backend pair must stay coherent or the next
   *  new chat launches as one provider told to run another's model. A thread
   *  handoff does not go through this: moving one conversation is not a
   *  statement about the next one. */
  onBackendChange: (backend: AgentBackend) => void;
  /** Default reasoning effort for new chats; "" = let the CLI decide. */
  effort: string;
  /** Persist a new default when the user switches this pane's effort. */
  onEffortChange: (effort: string) => void;
  /** Persist a new default when the user switches this pane's access level. */
  onAccessChange: (level: AccessLevel) => void;
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



export const ChatPane = memo(function ChatPane({
  sessionId,
  cwd,
  resume,
  imported = false,
  backend,
  active,
  fontFamily,
  fontSize,
  skipPermissions,
  persistent,
  permissionMode,
  model,
  onModelChange,
  onBackendChange,
  effort,
  onEffortChange,
  onAccessChange,
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
  // it respawns only this pane, not every mounted chat. The stored default is
  // provider-blind and a per-project pin can override the provider it was
  // picked under, so a model this backend cannot run is dropped here rather
  // than handed to the CLI.
  const [activeModel, setActiveModel] = useState(() =>
    modelFitsBackend(model, backend, getCustomModels()) ? model : ""
  );
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
  // just this pane (via --resume), like the model. Seeded from the stored
  // default and written back on change, so the next new thread starts here.
  const [access, setAccess] = useState(() =>
    accessLevelFrom(permissionMode, skipPermissions)
  );
  const changeAccess = useCallback(
    (level: AccessLevel) => {
      setAccess(level);
      onAccessChange(level);
    },
    [onAccessChange]
  );
  // Claude takes these as two mutually exclusive flags; the user picks one
  // thing. Split it here, at the boundary with the transport.
  const spawnAccess = accessLevelToSettings(access);
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
    asleep,
    wake,
    threadId,
    send,
    compact,
    rewind,
    revertTurn,
    queued,
    queue,
    stop,
    restart,
    exitReason,
    modelError,
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
    imported,
    backend: activeBackend,
    skipPermissions: spawnAccess.skipPermissions,
    persistent,
    permissionMode: spawnAccess.permissionMode,
    model: activeModel,
    effort: activeEffort,
    launch,
    codexSandbox,
    onTitled,
    visible: active,
  });
  // Register a fresh thread with the sidebar the moment it has both an id and a
  // first message. Without this the row only appears once the turn ends and the
  // transcript scan finds it on disk — a thread you are already talking to is
  // missing from the list for the whole first turn. The message stands in as the
  // title until the real one is generated.
  const startedRef = useRef(false);
  const firstUserMessage = messages.find((m) => m.role === "user")?.text;
  useEffect(() => {
    // An imported thread has no live provider thread yet, so the one its fresh
    // agent starts still needs registering — unlike an ordinary resume.
    if (startedRef.current || (resume && !imported) || !threadId || !firstUserMessage)
      return;
    startedRef.current = true;
    onThreadStarted?.(threadId, firstUserMessage);
  }, [resume, imported, threadId, firstUserMessage, onThreadStarted]);

  // Walks the whole thread, and the pane re-renders per published frame — a
  // 500-message thread would scan it several times a second otherwise.
  const lastActivity = useMemo(() => lastActivityAt(messages), [messages]);

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
    // A carried thread keeps its pinned model only when the new provider can
    // run it. The picker's switch re-pins the model right after this runs, so
    // this is the handoff path's guard.
    if (!modelFitsBackend(activeModel, to, getCustomModels())) {
      setActiveModel("");
    }
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
  // Sticky: has this pane ever been touched? A pane mounts at scrollTop 0 and
  // the virtualizer's own re-measurements fire scroll events, which used to
  // spend the whole auto-load budget before the user did anything — three extra
  // page reads, each a transcript query, in the pane's first frames.
  const userEngagedRef = useRef(false);
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
      revertTurn,
    }),
    [sessionId, cwd, activeBackend, activeModel, switchProvider, revertTurn]
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
    if (userEngagedRef.current && el.scrollTop < LOAD_EARLIER_PX) {
      autoLoadRef.current();
    }
  }, []);

  // Which scrolls came from the user. Virtualized rows re-measure after paint
  // and each correction fires a scroll event, so geometry alone can't tell a
  // drag from the pane settling into place.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = () => {
      userScrollRef.current = true;
      userEngagedRef.current = true;
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

  // Stable across renders so memoized rows don't re-render on every update.
  const openPreview = useCallback((dataUrl: string) => setPreview(dataUrl), []);

  const threadLink = useMemo(
    () => (resume ? { projectPath: cwd, threadId: resume } : null),
    [cwd, resume]
  );

  // ChatComposer is memoized and owns its own draft precisely so typing does
  // not re-render the transcript. Handing it a fresh arrow each frame defeats
  // that in the other direction. The backend is persisted here — this is the
  // picker's provider move — so the stored default pair stays coherent; the
  // model half is written by the pick itself, right after this.
  const switchBackend = useCallback(
    (to: AgentBackend) => {
      onBackendChange(to);
      switchProvider(to, false);
    },
    [switchProvider, onBackendChange]
  );
  const changeClaudeProfile = useCallback(
    (id: string | null) => {
      setClaudeProfileId(id);
      if (resume) {
        setThreadMeta(threadMetaKey(cwd, resume), {
          claudeProfileId: id ?? undefined,
        });
      }
    },
    [cwd, resume]
  );

  // Everything earlier providers produced, then whatever the live transport
  // has now — one transcript, however many providers it took.
  const thread = useMemo(
    () => mergeThread(carried, messages, activeBackend, activeModel || null),
    [carried, messages, activeBackend, activeModel]
  );

  // Group the flat message list into turns so a finished turn's work (thinking,
  // tools, subagents) can collapse under one "Worked for Ns" header.
  const turns = useMemo(() => groupTurns(thread), [thread]);

  // The scroll stream as virtual slots: optional load-earlier bookend and one
  // entry per turn (its provider-switch divider travels with it). Keys are
  // stable across prepends, which is what lets the virtualizer reuse measured
  // heights for already-seen rows.
  type Slot =
    | { key: string; kind: "load" }
    | {
        key: string;
        kind: "turn";
        turn: (typeof turns)[number];
        mark: ProviderSwitchMark | null;
      };
  // Every divider in one pass, rather than a scan of the thread per turn.
  const marks = useMemo(() => switchMarks(carried, thread), [carried, thread]);
  const slots = useMemo<Slot[]>(() => {
    const list: Slot[] = [];
    if (showLoadOlder(hasMore)) list.push({ key: "load", kind: "load" });
    for (const turn of turns) {
      list.push({
        key: `turn:${turn.key}`,
        kind: "turn",
        turn,
        mark: marks.get(turn.key) ?? null,
      });
    }
    return list;
  }, [turns, hasMore, marks]);

  // Read by the prepend settle loop below, which runs off rAF and so cannot
  // close over the render's `slots`.
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  // Not memoized: `slots` is a new array on every streamed frame, so a memo here
  // could never hit and only cost a deps comparison.
  let lastTurnIndex = -1;
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if (slots[i].kind === "turn") {
      lastTurnIndex = i;
      break;
    }
  }
  let firstTurnIndex = -1;
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i].kind === "turn") {
      firstTurnIndex = i;
      break;
    }
  }

  const rowVirt = useVirtualizer({
    count: slots.length,
    getScrollElement: () => scrollRef.current,
    // A height this pane measured last time it was open beats any estimate;
    // short turns dominate, and measureElement corrects the rest once the row
    // mounts.
    estimateSize: (index) =>
      rowSize(sessionId, slots[index]?.key) ??
      (slots[index]?.kind === "turn" ? 72 : 52),
    getItemKey: (index) => slots[index]?.key ?? String(index),
    overscan: 6,
  });

  // Hand the measurements to the next mount of this pane. Written on unmount
  // only: nothing reads them while the virtualizer is alive.
  const rowVirtRef = useRef(rowVirt);
  rowVirtRef.current = rowVirt;
  useEffect(
    () => () => rememberRowSizes(sessionId, rowVirtRef.current.itemSizeCache),
    [sessionId]
  );

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
    if (!turn) return null;
    const items = lastTodos(turn.assistants.flatMap((a) => a.tools));
    // The turn owns the clock, so the card above the composer and the same
    // plan once it settles into the transcript read the same record.
    return items ? { items, planKey: turn.key } : null;
  }, [busy, turns]);
  // A sleeping pane has no process, but it is waiting on the user — typing is
  // what wakes it, so the composer takes input exactly as if it were up.
  const inputReady = ready || asleep;
  // The quota strip is the only unprompted read of the plan windows; the chip
  // in the composer is passive. Recomputed per usage frame — the numbers only
  // move when the backend sends new ones.
  const quotaWarning = useMemo(
    () => quotaAlert(usage.quota, Date.now()),
    [usage.quota]
  );
  // Dismissal is per level, so waving off "80% used" does not also silence the
  // message that the window is actually gone.
  const [quotaDismissed, setQuotaDismissed] = useState<QuotaAlert["level"] | null>(
    null
  );
  const showQuota = quotaWarning && quotaDismissed !== quotaWarning.level;
  const todosSig =
    liveTodos?.items.map((t) => `${t.status}\0${t.text}`).join("\n") ?? "";
  const [tasksHidden, setTasksHidden] = useState(false);
  useEffect(() => setTasksHidden(false), [todosSig]);

  // Built on demand, not per render: an empty thread is by definition not
  // streaming, so eagerly constructing this set, filter and dropdown tree was
  // work only ever done in the case that throws it away.
  const renderNewThreadHeading = () => {
    const openProjectPaths = new Set(projects.map((project) => project.path));
    const recentOnly = recentProjects.filter(
      (path) => !openProjectPaths.has(path)
    );
    return (
    <h2 className="text-center text-3xl font-medium tracking-tight text-balance text-foreground">
      {inputReady ? (
        <>
          What should we build in{" "}
          <DropdownMenu>
            <DropdownMenuTrigger className="ember-text inline-flex items-center gap-1 underline decoration-border underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:rounded focus-visible:ring-1 focus-visible:ring-ring">
              {basename(cwd)}
              <ChevronDown className="size-4 no-underline text-muted-foreground opacity-60" />
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
  };

  return (
    <FileRefProject value={cwd}>
    {/* A fresh object here would defeat every consumer's memo — context does
        not compare — and PrLink renders every link in every message, each one
        re-reading thread meta from localStorage. Per streamed frame. */}
    <ThreadLinkProvider value={threadLink}>
    {/* A boolean, so no identity to stabilize. The tickers below read it
        rather than repainting a pane the `hidden` class has taken off screen. */}
    <PaneVisibleProvider value={active}>
    <div
      className="chat-pane relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      style={{ fontFamily }}
    >
      {imported && (
        // Said once, at the top, rather than per turn: the history below is
        // real, but the agent that answers the next prompt never saw it.
        <div className="z-10 flex items-center gap-2 border-b border-border/60 px-5 py-2 text-xs text-muted-foreground">
          <Archive className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Imported history. The agent has no memory of this conversation —
            sending a message starts a new thread from here.
          </span>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="contain-layout contain-style absolute inset-0 min-h-0 overflow-y-auto overscroll-contain"
        style={{ fontSize: `${fontSize}px` }}
      >
        {/* Padding stays outside the sized box: folding it in would put the
            bottom gutter *inside* getTotalSize() and leave the last turn ending
            flush with the scroll end, hidden under the composer. */}
        {/* No width of its own: the transcript and the composer are one column,
            so both are bounded by `.chat-content-width` and the same px-5. A
            narrower cap here left the answer text ending well short of the
            input it belongs to. */}
        <div className="mx-auto min-h-full w-full px-5 pb-64 pt-10">
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
                        {/* The turn rule is the transcript's rhythm: one hairline
                            centred in the gap between entries. A provider switch
                            is itself a separator, so it stands in for the rule
                            rather than stacking under one. */}
                        {vItem.index !== firstTurnIndex && !slot.mark && (
                          <div className="h-px shrink-0 bg-border/40" />
                        )}
                        {slot.mark && <ProviderSwitchDivider mark={slot.mark} />}
                        <TurnRow
                          turn={slot.turn}
                          newest={vItem.index === lastTurnIndex}
                          live={busy && vItem.index === lastTurnIndex}
                          fontSize={fontSize}
                          chat={chat}
                          onPreview={openPreview}
                        />
                      </Fragment>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Docked to the end of the output, not floated above the input: the
              clock belongs to the turn being written, so it trails the last
              message and scrolls with it. It sits inside the same column, so
              its dots line up with the transcript's own left edge. */}
          <div className="chat-content-width mx-auto pt-4">
            <WorkingFooter
              turnKey={busy ? (turns[turns.length - 1]?.key ?? sessionId) : undefined}
              busy={busy}
            />
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
          {thread.length === 0 && (
            <div className="mb-8">{renderNewThreadHeading()}</div>
          )}
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
          {showQuota && quotaWarning && (
            <QuotaNotice
              alert={quotaWarning}
              onDismiss={() => setQuotaDismissed(quotaWarning.level)}
            />
          )}
          {/* The picker keeps showing the model you asked for, so a refusal has
              to say what is actually running or the two quietly disagree. */}
          {modelError && !terminal && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-red-400" />
              <span className="min-w-0 flex-1">
                {modelError}
                {usage.model ? ` — still on ${usage.model}.` : "."}
              </span>
            </div>
          )}
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
                  {/* Sits *behind* the composer's rounded top edge rather than
                      above it — the extra bottom padding is what the composer
                      covers, so the two read as one surface. */}
                  {liveTodos && !tasksHidden && (
                    <div className="relative z-0 -mb-4">
                      <TasksCard
                        items={liveTodos.items}
                        planKey={liveTodos.planKey}
                        collapsible
                        onDismiss={() => setTasksHidden(true)}
                      />
                    </div>
                  )}
                  <div className="relative z-10">
                <ChatComposer
                  cwd={cwd}
                  backend={activeBackend}
                  active={active}
                  fontFamily={fontFamily}
                  ready={inputReady}
                  busy={busy}
                  queued={queued}
                  exited={terminal}
                  usage={usage}
                  model={activeModel}
                  onModelChange={changeModel}
                  effort={activeEffort}
                  onEffortChange={changeEffort}
                  access={access}
                  onAccessChange={changeAccess}
                  onSwitchBackend={switchBackend}
                  claudeProfiles={claudeProfiles}
                  claudeProfileId={claudeProfileId}
                  onClaudeProfileChange={changeClaudeProfile}
                  queue={queue}
                  draft={draft}
                  onDraftConsumed={consumeDraft}
                  onTyping={wake}
                  onSend={send}
                  onCompact={compact}
                  lastActivityAt={lastActivity}
                  onStop={stop}
                  onRewind={rewind}
                  onPreview={setPreview}
                />
                </div>
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
    </PaneVisibleProvider>
    </ThreadLinkProvider>
    </FileRefProject>
  );
});

/** The plan window running out, said before it stops the work rather than
 *  after. `AccountNotice` explains a session that already died; this one is a
 *  warning while the session is still usable, so it is dismissible. */
function QuotaNotice({
  alert,
  onDismiss,
}: {
  alert: QuotaAlert;
  onDismiss: () => void;
}) {
  const spent = alert.level === "exhausted";
  return (
    <div
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs",
        // The icon carries the severity; a filled status box is costume.
        spent ? "text-red-400" : "text-amber-400"
      )}
    >
      <Gauge className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 text-foreground">
        <span className="font-medium">{quotaMessage(alert)}</span>
        {alert.resets && (
          <span className="ml-1 text-muted-foreground">{alert.resets}.</span>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-70 hover:opacity-100"
        aria-label="Dismiss usage warning"
      >
        <X className="size-3.5" />
      </button>
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
        "mb-2 flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs",
        limited ? "text-amber-400" : "text-red-400"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 text-foreground">
        <div className="font-medium">{issueTitle(issue)}</div>
        <div className="mt-0.5 break-words text-muted-foreground">
          {issue.message}
        </div>
        {reset && <div className="mt-0.5 text-muted-foreground">{reset}</div>}
      </div>
    </div>
  );
}

/** Elapsed time per task, captured at status transitions so the card can show
 *  "2m 35s" / "now" without the tool payload carrying clocks. The record lives
 *  outside React (`lib/todoTimings`) because the transcript is virtualized and
 *  a card that owned it lost everything on remount. */
const useTodoTimings = (planKey: string, items: TodoItem[]) =>
  recordTodoTimings(todoTimings, planKey, items, Date.now());

const TasksCard = memo(function TasksCard({
  items,
  planKey,
  onDismiss,
  /** Live plans ride above the composer collapsed — one line, the task in
   *  flight. A settled turn's card in the transcript has room to list. */
  collapsible = false,
}: {
  items: TodoItem[];
  /** Which plan these tasks belong to — the turn's message id. Two turns'
   *  plans must not share a clock. */
  planKey: string;
  onDismiss?: () => void;
  collapsible?: boolean;
}) {
  const timings = useTodoTimings(planKey, items);
  const [open, setOpen] = useState(!collapsible);
  const expanded = !collapsible || open;
  const done = items.filter((t) => t.status === "completed").length;
  const current = collapsible ? currentTodo(items) : null;
  const header = (
    <>
      <ListTodo className="size-4 shrink-0 text-muted-foreground" />
      {current && !expanded ? (
        <span className="min-w-0 flex-1 truncate text-left">{current.text}</span>
      ) : (
        <span className="font-medium">Tasks</span>
      )}
      <span
        className={cn(
          "shrink-0 tabular-nums text-muted-foreground",
          !collapsible && "font-medium text-foreground"
        )}
      >
        {done}/{items.length}
      </span>
      {collapsible && (
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      )}
    </>
  );
  return (
    <div
      className={cn(
        "chat-work-panel border",
        // Tucked behind the composer, which is why the bottom corners are
        // square: the seam is covered rather than drawn.
        // pb-6 against the composer's -mb-4 overlap: 16px of this card is
        // covered, so anything less than that clips its own last row.
        collapsible ? "rounded-t-xl border-b-0 pb-6" : "rounded-xl"
      )}
    >
      {collapsible ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {header}
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Dismiss tasks"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ) : (
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
      )}
      {expanded && (
      <ul className="flex flex-col px-3 pb-2">
        {items.map((item, i) => {
          const t = timings.get(i);
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
      )}
    </div>
  );
});

/** The file delta one settled turn produced, from the snapshot taken before it
 *  to its settle snapshot (or the next turn's — the Rust side resolves it).
 *  The full diff lives in the dock's diff tab; this card is the doorway to it,
 *  the way Waku scopes Review to a turn. Directories start folded — the card
 *  opens as one summary row per tree, not a wall of paths. */
const ChangedFilesCard = memo(function ChangedFilesCard({
  projectPath,
  threadId,
  fromId,
  openEnded,
}: {
  projectPath: string;
  threadId: string;
  fromId: string;
  /** The newest turn's range ends at the working tree, so it alone re-reads. */
  openEnded: boolean;
}) {
  const { data: files } = useTurnFiles(projectPath, threadId, fromId, true, openEnded);
  // Null until the user folds or unfolds something — the default (everything
  // folded) is recomputed from the tree each render, so a refetch of the
  // newest turn's delta can't resurrect rows the user hasn't ruled on, and
  // their explicit toggles survive one.
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const requestTurnReview = useAgentStore((s) => s.requestTurnReview);
  if (!files || files.length === 0) return null;
  const { additions, deletions } = sumRangeFiles(files);
  const tree = buildTree(
    files.map((file) => ({ path: file.path, status: "  " }))
  );
  const dirPaths = tree.filter((row) => row.kind === "dir").map((row) => row.path);
  const folded = collapsed ?? new Set(dirPaths);
  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev ?? dirPaths);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };
  const shown =
    folded.size === 0
      ? tree
      : tree.filter(
          (row) =>
            ![...folded].some(
              (dir) => row.path !== dir && row.path.startsWith(`${dir}/`)
            )
        );
  const totals = dirTotals(files);
  return (
    <div className="chat-work-panel overflow-hidden rounded-xl border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <FileDiff className="size-4 flex-none shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-medium">
            {files.length === 1 ? "Changed 1 file" : `Changed ${files.length} files`}
          </span>
          <span className="flex flex-none gap-2 text-xs tabular-nums">
            <span className="text-emerald-400">+{additions}</span>
            <span className="text-red-400">−{deletions}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => requestTurnReview({ projectPath, threadId, fromId })}
          className="flex flex-none items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <FileDiff className="size-3.5" />
          Review
        </button>
      </div>
      <div className="flex flex-col border-t border-border py-1">
        {shown.map((row) => {
          const file = row.kind === "file" ? files.find((f) => f.path === row.path) : undefined;
          const indent = { paddingLeft: 12 + row.depth * 12 };
          if (row.kind === "dir") {
            const closed = folded.has(row.path);
            const total = totals.get(row.path);
            return (
              <button
                key={`dir:${row.path}`}
                type="button"
                style={indent}
                onClick={() => toggleDir(row.path)}
                title={closed ? `Show files in ${row.path}` : `Hide files in ${row.path}`}
                className="flex h-7 items-center gap-1.5 pr-3 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="flex size-3 shrink-0 items-center justify-center">
                  {closed ? (
                    <ChevronRight className="size-3 opacity-60" />
                  ) : (
                    <ChevronDown className="size-3 opacity-60" />
                  )}
                </span>
                <Folder className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {total?.counted && (
                  <span className="flex flex-none gap-2 tabular-nums">
                    <span className="text-emerald-400/80">+{total.additions}</span>
                    <span className="text-red-400/80">−{total.deletions}</span>
                  </span>
                )}
              </button>
            );
          }
          return (
            <div
              key={row.path}
              style={indent}
              className="flex h-7 items-center gap-1.5 pr-3 text-xs"
              title={row.path}
            >
              <span className="size-3 shrink-0" />
              <FileTypeIcon path={row.path} />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {file?.additions != null && (
                <span className="flex-none tabular-nums text-emerald-400">
                  +{file.additions}
                </span>
              )}
              {file?.deletions != null && (
                <span className="flex-none tabular-nums text-red-400">
                  −{file.deletions}
                </span>
              )}
            </div>
          );
        })}
      </div>
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
    newest,
    fontSize,
    chat,
    onPreview,
  }: {
    turn: Turn;
    live: boolean;
    /** The last turn in the transcript — its file delta is still open-ended. */
    newest: boolean;
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
                  live
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {turnTodos && <TasksCard items={turnTodos} planKey={turn.key} />}
              <TurnWork label={turnWorkLabel(assistants)} agentsRunning={agentsRunning}>
                {assistants.map((a, i) => (
                  <Fragment key={a.id}>
                    <MessageWork message={a} active={false} />
                    {/* Only interstitial narration stays inside; the final
                        answer is shown below the accordion. */}
                    {i < assistants.length - 1 && a.text && (
                      <Markdown text={a.text} fontSize={fontSize} />
                    )}
                  </Fragment>
                ))}
              </TurnWork>
              {last?.text && (
                <div className="group relative flex flex-col gap-2">
                  <Markdown text={last.text} fontSize={fontSize} />
                  <MessageActions text={last.text} chat={chat} />
                </div>
              )}
            </div>
          ))}
        {user?.checkpointId && !live && (
          <ChangedFilesCard
            projectPath={chat.cwd}
            threadId={chat.sessionId}
            fromId={user.checkpointId}
            openEnded={newest}
          />
        )}
      </>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.newest === b.newest &&
    a.fontSize === b.fontSize &&
    a.chat === b.chat &&
    a.turn.user === b.turn.user &&
    a.turn.assistants.length === b.turn.assistants.length &&
    a.turn.assistants.every((m, i) => m === b.turn.assistants[i])
);

/** What one turn's work amounts to, in words. Falls back to a tool count for
 *  a replayed transcript that never carried an activity stream. */
function turnWorkLabel(assistants: ChatMessage[]): string | null {
  const rows = assistants.flatMap(
    (m) => m.activities?.filter((a) => !isTodoTool(a.title)) ?? []
  );
  if (rows.length) return summarizeWork(rows);
  const tools = assistants.flatMap((m) => m.tools.filter((t) => !isTodoTool(t.name)));
  if (tools.length)
    return `Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  return assistants.some((m) => m.thinking) ? "Ran 1 thought" : null;
}

/** A settled turn's work: one summary line — "Ran 1 thought · 5 commands" —
 *  over the turn's rows, one work panel per message. Collapsed by default, but
 *  stays open while the turn's subagents are still running: `null` means the
 *  user hasn't decided, so the running count does. */
function TurnWork({
  label,
  agentsRunning,
  children,
}: {
  label: string | null;
  agentsRunning: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? agentsRunning > 0;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className={cn(
          "flex items-center gap-1.5 self-start text-xs font-medium transition-colors hover:text-foreground",
          agentsRunning > 0 ? "text-violet-400" : "text-muted-foreground"
        )}
      >
        {agentsRunning > 0 ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            {agentsRunning === 1
              ? "1 agent running"
              : `${agentsRunning} agents running`}
          </>
        ) : (
          (label ?? "Work log")
        )}
        <ChevronRight
          className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-2">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Tool cards for a message; agent/Task tools render their subagent inline.
 *  TodoWrite is lifted into TasksCard so it isn't a generic tool row. */
function ToolList({
  tools,
  live,
  framed = true,
}: {
  tools: ToolCall[];
  live?: boolean;
  framed?: boolean;
}) {
  const rest = tools.filter((t) => !isTodoTool(t.name));
  if (rest.length === 0) return null;
  const activities = rest.map((t) =>
    buildActivityRow({
      id: t.id,
      kind: kindForToolName(t.name),
      title: t.name,
      input: t.input,
      output: t.result,
      failed: t.isError,
      complete: t.result != null,
    })
  );
  return (
    <ActivityList
      activities={activities}
      live={live}
      framed={framed}
      renderAgent={(a) => {
        const tool = rest.find((t) => t.id === a.id);
        return tool && isAgentTool(tool.name) ? (
          <SubagentInline id={a.id} tool={tool} />
        ) : null;
      }}
    />
  );
}

/** A message's work.
 *
 *  A provider that produces an ordered stream renders it, so reasoning sits
 *  between the tool calls it came between. A replayed transcript has only
 *  `thinking` and `tools` — it never recorded an order — so it keeps the old
 *  shape rather than being given one it cannot back up. */
function MessageWork({
  message,
  active,
  live,
}: {
  message: ChatMessage;
  active: boolean;
  live?: boolean;
}) {
  const stream = message.activities;
  if (stream?.length) {
    // TodoWrite is lifted into TasksCard, so it is not a row here either.
    const rows = stream.filter((a) => !isTodoTool(a.title));
    if (rows.length === 0) return null;
    return (
      <ActivityList
        activities={rows}
        live={live}
        renderAgent={(a) => {
          const tool = message.tools.find((t) => t.id === a.id);
          return tool ? <SubagentInline id={a.id} tool={tool} /> : null;
        }}
      />
    );
  }
  if (!message.thinking && message.tools.length === 0) return null;
  // No recorded order, so thinking stays above tools — but on the same one
  // panel the streamed path uses, as hairline rows on it rather than boxes.
  return (
    <div className="chat-work-panel flex flex-col divide-y divide-border/50 overflow-hidden rounded-xl border">
      {message.thinking && (
        <ThinkingBlock
          text={message.thinking}
          active={active}
          timingKey={message.id}
        />
      )}
      {message.tools.length > 0 && (
        <ToolList tools={message.tools} live={live} framed={false} />
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
  const visible = usePaneVisible();
  const [showAll, setShowAll] = useState(false);
  const running = run ? run.endedAt == null : false;
  useEffect(() => {
    // Same reason as the running timers: a hidden pane's runs settle when it
    // comes back, which is the first moment anyone can see the difference.
    if (!running || !visible) return;
    settle();
    const t = window.setInterval(() => settle(), 1000);
    return () => window.clearInterval(t);
  }, [running, visible, settle]);

  // Not tracked as a run (shouldn't happen) — fall back to a plain tool card.
  if (!run) return <ToolCard tool={tool} />;

  const LIMIT = 4;
  const shown = showAll ? run.activity : run.activity.slice(-LIMIT);

  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
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
        ) : null}
      </div>
      {run.activity.length > 0 && (
        <div className="mx-3 mb-2 flex flex-col gap-1 border-l border-border/60 pl-2.5 text-muted-foreground">
          {run.activity.length > LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="self-start text-xs transition-colors hover:text-foreground"
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
  live,
}: {
  message: ChatMessage;
  fontSize: number;
  chat: ChatContext;
  onPreview: (dataUrl: string) => void;
  live?: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {message.images && message.images.length > 0 && (
          <div className="flex max-w-prose flex-wrap justify-end gap-2">
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
          <div className="chat-bubble max-w-prose whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-foreground/90">
            <TextWithFileRefs text={message.text} />
          </div>
        )}
        {message.checkpointId && (
          <RevertTurnButton
            projectPath={chat.cwd}
            threadId={chat.sessionId}
            checkpointId={message.checkpointId}
            rewindConversation={capabilitiesOf(chat.backend).conversationRewind}
            onRevertConversation={chat.revertTurn}
          />
        )}
      </div>
    );
  }
  return (
    <div className="group relative flex flex-col gap-2">
      <MessageWork
        message={message}
        active={message.streaming && !message.text && message.tools.length === 0}
        live={live}
      />
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
  revertTurn: (checkpointId: string) => Promise<void>;
}

/** Where the thread changed hands. Rendered in the transcript rather than as a
 *  toast, because which provider wrote which turn is part of reading it back. */
function ProviderSwitchDivider({ mark }: { mark: ProviderSwitchMark }) {
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
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

/** Old vs new for an Edit, as a syntax-highlighted unified diff. */
function RevertTurnButton({
  projectPath,
  threadId,
  checkpointId,
  rewindConversation,
  onRevertConversation,
}: {
  projectPath: string;
  threadId: string;
  checkpointId: string;
  rewindConversation: boolean;
  onRevertConversation: (checkpointId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const invalidateGit = useInvalidateGit();

  const revert = async () => {
    setBusy(true);
    try {
      const changes = await checkpointChanges(projectPath, checkpointId);
      if (changes.length === 0 && !rewindConversation) {
        toast.info("Nothing to revert", {
          description: "The working tree is unchanged since this turn.",
        });
        return;
      }
      const added = changes.filter((c) => c.kind === "added");
      const question = rewindConversation
        ? changes.length > 0
          ? `${describeRestore(changes)}.\n\nRestore the working tree and drop this turn from the conversation?`
          : "Drop this turn and everything after it from the conversation?"
        : `${describeRestore(changes)}.\n\nRestore the working tree to before this turn?`;
      const ok = await ask(question, { title: "Revert turn", kind: "warning" });
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
      // Provider first: if rewind fails the tree still matches the conversation.
      if (rewindConversation) await onRevertConversation(checkpointId);
      if (changes.length > 0) {
        await restoreCheckpoint(projectPath, checkpointId, removeAdded);
        invalidateGit(projectPath);
      }
      // A revert is a durable fact about the thread, not just a toast.
      void invoke("thread_timeline_append", {
        threadId,
        kind: "checkpointReverted",
        attribution: null,
        payload: JSON.stringify({
          checkpointId,
          removeAdded,
          changes: changes.length,
          conversation: rewindConversation,
        }),
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
      title={
        rewindConversation
          ? "Restore the working tree and conversation to before this turn"
          : "Restore the working tree to before this turn"
      }
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground group-hover:opacity-100 disabled:opacity-40"
    >
      <Undo2 className="size-3.5" />
      Revert turn
    </button>
  );
}
