import { Fragment, memo, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { markPainted, onRender } from "@/lib/perf";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  ChevronDown,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { basename } from "@/lib/path";
import { Button } from "@/components/ui/button";
import { FileRefProject } from "@/components/FileRef";
import type { AgentBackend } from "@/lib/agentBackend";
import { lastTodos } from "@/lib/toolDisplay";
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
import { ChatComposer } from "@/components/ChatComposer";
import { draftForSwitch, handoffTurnsFrom } from "@/lib/handoff";
import {
  EMPTY_THREAD,
  carryOver,
  mergeThread,
  switchMarks,
  type CarriedThread,
  type ProviderSwitchMark,
} from "@/lib/thread";
import { quotaAlert, type QuotaAlert } from "@/lib/quota";
import {
  accessLevelFrom,
  accessLevelToSettings,
  type AccessLevel,
  type PermissionMode,
  type Settings,
} from "@/lib/settings";
import { launchFor } from "@/lib/settings";
import { getThreadMeta, setThreadMeta, threadMetaKey } from "@/lib/threadMeta";
import {
  formatKeepGoingLabel,
  isKeepGoingOn,
  type KeepGoing,
} from "@/lib/keepGoing";
import { lastActivityAt } from "@/lib/compact";
import { ThreadLinkProvider } from "@/components/PrLink";
import { PaneVisibleProvider } from "@/components/chat/PaneVisible";
import type { Project } from "@/types";
import { projectLabel } from "@/lib/worktree";
import { useAgentStore } from "@/lib/agentStore";
import { rememberRowSizes, rowSize } from "@/lib/rowSizes";
import { cn } from "@/lib/utils";
import { modelFitsBackend } from "@/lib/modelCatalog";
import { getCustomModels } from "@/lib/modelFavorites";
import { groupTurns } from "@/components/chat/turns";
import { AskPrompt, PlanPrompt, PermissionPrompt } from "@/components/chat/Prompts";
import { WorkingFooter } from "@/components/chat/WorkingFooter";
import { AccountNotice, QuotaNotice } from "@/components/chat/Notices";
import { TasksCard } from "@/components/chat/TasksCard";
import { TurnRow } from "@/components/chat/TurnRow";
import { ProviderSwitchDivider } from "@/components/chat/ProviderSwitchDivider";

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
   *  new chat launches as one provider told to run another's model. */
  onBackendChange: (backend: AgentBackend) => void;
  /** Default reasoning effort for new chats; "" = let the CLI decide. */
  effort: string;
  /** Persist a new default when the user switches this pane's effort. */
  onEffortChange: (effort: string) => void;
  /** Persist a new default when the user switches this pane's access level. */
  onAccessChange: (level: AccessLevel) => void;
  jevAutoApprove: boolean;
  onJevAutoApproveChange: (v: boolean) => void;
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
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void;
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
  jevAutoApprove,
  onJevAutoApproveChange,
  providerLaunch,
  claudeProfiles,
  codexSandbox,
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
  onTitled,
  onThreadStarted,
  onOpenWorktree,
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
  const [keepGoing, setKeepGoing] = useState<KeepGoing | undefined>(() =>
    resume ? getThreadMeta(threadMetaKey(cwd, resume)).keepGoing : undefined
  );
  const changeAccess = useCallback(
    (level: AccessLevel) => {
      setAccess(level);
      onAccessChange(level);
      if (level !== "full") setKeepGoing(undefined);
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
    pendingPlan,
    answerPlan,
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
    keepGoing,
    onKeepGoingTurn: setKeepGoing,
    onKeepGoingStop: () => setKeepGoing(undefined),
  });
  useEffect(() => {
    const id = threadId ?? resume;
    if (!id) return;
    setThreadMeta(threadMetaKey(cwd, id), { keepGoing });
  }, [cwd, keepGoing, resume, threadId]);
  const keepGoingOn = isKeepGoingOn(keepGoing, usage);
  const stopKeepGoing = useCallback(() => {
    setKeepGoing(undefined);
    stop();
  }, [stop]);
  useEffect(() => {
    if (!keepGoingOn || !pendingPlan) return;
    answerPlan("approved", "");
  }, [keepGoingOn, pendingPlan, answerPlan]);
  // Register a fresh thread with the sidebar the moment it has both an id and a
  // first message. Without this the row only appears once the turn ends and the
  // transcript scan finds it on disk — a thread you are already talking to is
  // missing from the list for the whole first turn. The message stands in as the
  // title until the real one is generated.
  //
  // A resumed thread already has a row, including imported ACP history. The
  // agent behind an imported thread is always fresh (the provider keeps no
  // session store) and the pane paints only the tail page, so treating that
  // agent's new id as a new thread named the row after whatever user prompt
  // happened to sit in the tail — a console dump, a later "create the patch"
  // — and a restart minted another one.
  const startedRef = useRef(false);
  const firstUserMessage = messages.find((m) => m.role === "user")?.text;
  useEffect(() => {
    if (startedRef.current || resume || !threadId || !firstUserMessage) return;
    startedRef.current = true;
    onThreadStarted?.(threadId, firstUserMessage);
  }, [resume, threadId, firstUserMessage, onThreadStarted]);

  // Walks the whole thread, and the pane re-renders per published frame — a
  // 500-message thread would scan it several times a second otherwise.
  const lastActivity = useMemo(() => lastActivityAt(messages), [messages]);

  // The transcript is read at switch time, not published per token —
  // publishing it on every token would re-render the world.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  /**
   * Move this thread to another provider without leaving the pane. The turns
   * so far are carried and stamped, the transport is swapped, and the context
   * package lands in the composer — prefilled, never sent, so the user still
   * decides what the next provider is actually asked. An empty thread skips
   * the draft: there is nothing to hand over.
   */
  const switchProvider = useCallback(
    (to: AgentBackend) => {
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
    const draft = draftForSwitch({
      from: activeBackend,
      to,
      cwd,
      turns: handoffTurnsFrom(messagesRef.current, activeBackend, activeModel || null),
    });
    if (draft) useAgentStore.getState().setDraft(sessionId, draft);
    setActiveBackend(to);
    // A carried thread keeps its pinned model only when the new provider can
    // run it. The picker's switch re-pins the model right after this runs, so
    // this is the switch path's guard.
    if (!modelFitsBackend(activeModel, to, getCustomModels())) {
      setActiveModel("");
    }
    void invoke("thread_timeline_append", {
      threadId: sessionId,
      kind: "providerSwitch",
      attribution: { provider: to, model: null, nativeThreadId: sessionId },
      payload: JSON.stringify({ from: activeBackend, to, inPlace: true }),
    }).catch(() => {});
    },
    [activeBackend, activeModel, cwd, sessionId]
  );

  // The lightbox: the image, and — for a snapshot — the accessibility tree
  // under it. Null when closed.
  const [preview, setPreview] = useState<{ url: string; a11y?: string } | null>(
    null
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // Composer overlay sits on the transcript; this is the gutter that keeps the
  // last turn from ending under it. Starts at the old `pb-64` so the first
  // paint matches, then tracks the real dock (a plan card is much taller).
  const [dockH, setDockH] = useState(256);
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
      revertTurn,
    }),
    [sessionId, cwd, activeBackend, revertTurn]
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

  // The sidebar names the session's backend, which an in-place switch leaves
  // alone; publish the one this pane actually runs while they differ.
  const setSwitchedBackend = useAgentStore((s) => s.setSwitchedBackend);
  useEffect(() => {
    setSwitchedBackend(sessionId, activeBackend === backend ? null : activeBackend);
    return () => setSwitchedBackend(sessionId, null);
  }, [sessionId, activeBackend, backend, setSwitchedBackend]);

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

  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const next = Math.ceil(el.getBoundingClientRect().height);
      setDockH((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, [pendingPlan, pendingPermission, pendingAsk, status, messages.length]);

  const busy = status === "thinking" || status === "streaming" || status === "tool";
  // Both are dead ends for this session — `error` used to render nothing and
  // left the composer live with no agent behind it.
  const terminal = status === "exited" || status === "error";
  const accountIssue = useAgentStore((s) => s.accountIssue);

  // Stable across renders so memoized rows don't re-render on every update.
  const openPreview = useCallback(
    (dataUrl: string, a11y?: string) => setPreview({ url: dataUrl, a11y }),
    []
  );

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
      switchProvider(to);
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
  // tools, subagents) renders as one unit and the live clock has a turn to own.
  const turns = useMemo(() => groupTurns(thread), [thread]);
  const hasTurns = turns.length > 0;
  useEffect(() => {
    if (active && hasTurns) markPainted();
  }, [active, hasTurns]);

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
      {imported && !threadId && (
        // Until the fresh agent names a thread: the history below is real,
        // but the agent that answers the next prompt never saw it.
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
        <div
          className="mx-auto min-h-full w-full px-5 pt-10"
          style={{ paddingBottom: dockH }}
        >
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
      </div>
      {/* A sibling of the scroller, not a child: positioned inside it, the
          button was anchored to the scrolled content and drifted up through
          the transcript with it. */}
      {showScrollEnd && (
        <button
          type="button"
          onClick={scrollToEnd}
          className="absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
          style={{ bottom: dockH + 8 }}
        >
          <ChevronDown className="size-3.5" />
          Scroll to end
        </button>
      )}

      <div
        ref={dockRef}
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
              {pendingPlan ? (
                <PlanPrompt
                  pending={pendingPlan}
                  onAnswer={answerPlan}
                  fontSize={fontSize}
                />
              ) : pendingPermission ? (
                <PermissionPrompt pending={pendingPermission} onDecide={respond} />
              ) : pendingAsk ? (
                <AskPrompt pending={pendingAsk} onAnswer={answerAsk} />
              ) : (
                <>
                  {/* Sits *behind* the composer's rounded top edge rather than
                      above it — the extra bottom padding is what the composer
                      covers, so the two read as one surface. */}
                  {liveTodos && !tasksHidden && (
                    <div className="chat-composer-shelf relative z-0 -mb-4">
                      <TasksCard
                        items={liveTodos.items}
                        planKey={liveTodos.planKey}
                        collapsible
                        onDismiss={() => setTasksHidden(true)}
                      />
                    </div>
                  )}
                  <div className="relative z-10">
                {keepGoingOn && keepGoing && (
                  <div className="mb-2 flex items-center justify-between rounded-lg border border-border/60 bg-card px-3 py-1.5 text-xs">
                    <span>{formatKeepGoingLabel(keepGoing, usage.costUsd, persistent)}</span>
                    <button
                      type="button"
                      onClick={stopKeepGoing}
                      className="rounded-md px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-white/[0.04]"
                    >
                      Stop
                    </button>
                  </div>
                )}
                <Profiler id="Composer" onRender={onRender}>
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
                  jevAutoApprove={jevAutoApprove}
                  onJevAutoApproveChange={onJevAutoApproveChange}
                  onSwitchBackend={switchBackend}
                  claudeProfiles={claudeProfiles}
                  claudeProfileId={claudeProfileId}
                  onClaudeProfileChange={changeClaudeProfile}
                  queue={queue}
                  keepGoing={keepGoing}
                  onKeepGoingChange={setKeepGoing}
                  onKeepGoingStop={stopKeepGoing}
                  onOpenWorktree={onOpenWorktree}
                  draft={draft}
                  onDraftConsumed={consumeDraft}
                  onTyping={wake}
                  onSend={send}
                  onCompact={compact}
                  lastActivityAt={lastActivity}
                  onStop={stopKeepGoing}
                   onRewind={rewind}
                   onPreview={openPreview}
                />
                </Profiler>
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
            <>
              <img
                src={preview.url}
                alt=""
                className="max-h-[80vh] w-full rounded-lg object-contain"
              />
              {/* A snapshot's tree, compact under the picture: the same text
                  the agent receives, for a human to inspect first. */}
              {preview.a11y && (
                <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-border bg-card p-4 font-mono text-xs leading-5 text-muted-foreground">
                  {preview.a11y}
                </pre>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </PaneVisibleProvider>
    </ThreadLinkProvider>
    </FileRefProject>
  );
});
