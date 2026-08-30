import { useEffect, useMemo, useRef, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { type Settings } from "@/lib/settings";
import {
  BACKEND_LABEL,
  capabilitiesOf,
  type AgentBackend,
} from "@/lib/agentBackend";
import { listCodexThreads } from "@/lib/codex/transport";
import { projectBackend } from "@/lib/projectConfig";
import {
  INSTRUCTION_FILES,
  findHandoffTarget,
  otherBackend,
  renderHandoffContext,
  type HandoffContext,
} from "@/lib/handoff";
import type { Provider } from "@/lib/providers";
import { fetchWorkingDiff } from "@/lib/queries";
import {
  useAgentStore,
  type HandoffRequest,
} from "@/lib/agentStore";
import { getRecents, addRecent, removeRecent } from "@/lib/recents";
import { getOpenProjects, saveOpenProjects } from "@/lib/openProjects";
import { cachedThreads, cacheThreads } from "@/lib/threadCache";
import { disposeLog, killLog, spawnLog } from "@/lib/ptyLog";
import { useProjects } from "@/hooks/useProjects";
import { useSessions } from "@/hooks/useSessions";
import type {
  DirEntry,
  GitBranch,
  Session,
  Thread,
  WorkspaceInfo,
} from "@/types";

/** Thread titles are truncated to this in tab labels. */
const LABEL_MAX = 24;

/** The branch the project sits on. Best-effort — a non-repo directory simply
 *  has no branch to name. */
const fetchBranch = async (path: string): Promise<string | undefined> => {
  try {
    const branch = await invoke<GitBranch>("git_branch", { path });
    return branch?.branch || undefined;
  } catch {
    return undefined;
  }
};

/** Which conventional instruction files the project actually has. Probed, not
 *  assumed: naming a file the repo doesn't have is a lie the target would act on. */
const fetchInstructions = async (path: string): Promise<string[]> => {
  try {
    const entries = await invoke<DirEntry[]>("list_dir", { path });
    const present = new Set(
      (entries ?? []).filter((entry) => !entry.isDir).map((entry) => entry.name)
    );
    return INSTRUCTION_FILES.filter((name) => present.has(name));
  } catch {
    return [];
  }
};

/** Note a provider switch on a thread's durable timeline, from both sides — the
 *  source records that the conversation left, the target that it arrived.
 *  Best-effort: a runtime that can't record it must not block the handoff. */
const recordProviderSwitch = (
  threadId: string,
  from: Provider,
  to: Provider,
  peerThreadId: string
) =>
  invoke("thread_timeline_append", {
    threadId,
    kind: "providerSwitch",
    attribution: { provider: to, model: null, nativeThreadId: peerThreadId },
    payload: JSON.stringify({ from, to, peerThreadId }),
  }).catch((e) => console.error("provider switch not recorded:", e));

/** Each backend keeps its own conversation store: Claude's transcripts on disk,
 *  Codex's in its app-server. A backend with no store of its own lists nothing
 *  — reading Claude's transcripts for it would file another agent's history
 *  under its name. */
const listThreads = async (backend: AgentBackend, cwd: string): Promise<Thread[]> => {
  if (!capabilitiesOf(backend).threads) return [];
  if (backend === "codex") return listCodexThreads(cwd);
  // Two sources answering different questions: the transcript scan, and the
  // event log for imported history that was never a file here. Imported
  // threads are listed for Claude alone — it is the pane that can render the
  // log's stored lines, and a row you cannot open is worse than none.
  const [scanned, imported] = await Promise.all([
    invoke<Thread[]>("list_threads", { cwd }),
    invoke<Thread[]>("list_store_threads", { cwd }).catch((e) => {
      console.error("list_store_threads failed:", e);
      return [] as Thread[];
    }),
  ]);
  const scannedIds = new Set(scanned.map((t) => t.id));
  return [...scanned, ...imported.filter((t) => !scannedIds.has(t.id))].sort(
    (a, b) => b.modified - a.modified
  );
};

/** Threads a fresh agent can actually continue, newest first. */
const resumable = (threads: Thread[]): Thread[] =>
  threads.filter((t) => !t.imported).sort((a, b) => b.modified - a.modified);

const labelFor = (thread: Thread) =>
  thread.title.length > LABEL_MAX
    ? `${thread.title.slice(0, LABEL_MAX)}…`
    : thread.title;

/**
 * The app's workspace model: open projects, their sessions, and every action
 * that changes which project or thread is live — opening, pre-warming,
 * resuming, spawning agents, and tearing down. App renders what this returns.
 */
/** A project's primary agent session — always a chat pane. */
const isPrimaryAgent = (s: Session) => s.kind === "chat";

export function useWorkspace(settings: Settings) {
  const [recents, setRecents] = useState<string[]>(getRecents);
  // The most-recent project is pre-warmed (its agent booted) hidden behind the
  // WelcomeScreen at launch, so opening it is instant. Until the user reveals a
  // project, the UI treats nothing as active — the pre-warm pane stays mounted
  // (so it boots) but hidden.
  const [revealed, setRevealed] = useState(false);
  const prewarmRef = useRef<{ id: string; path: string } | null>(null);

  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    openProject,
    setWorkspace,
    setIcon,
    setThreads,
    closeProject,
  } = useProjects();

  // Projects removed while an open was still in flight. A superseded pre-warm
  // must not resurrect one (which would orphan a PTY). Recorded rather than
  // read off `projects`, which a freshly opened project hasn't rendered into
  // yet — how long an async open takes decided the answer otherwise.
  const torndownRef = useRef(new Set<string>());

  const sessionApi = useSessions();
  const {
    sessions,
    activeByProject,
    setActive,
    startChat,
    closeProjectSessions,
    sessionsFor,
  } = sessionApi;

  const uiActiveProjectId = revealed ? activeProjectId : null;
  const activeProject = projects.find((p) => p.id === uiActiveProjectId) ?? null;
  const projectSessions = useMemo(
    () => (uiActiveProjectId ? sessionsFor(uiActiveProjectId) : []),
    // sessionsFor derives from `sessions`; recompute only when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, uiActiveProjectId]
  );
  const activeId = uiActiveProjectId
    ? activeByProject[uiActiveProjectId] ?? null
    : null;

  /** The backend a project runs — its own pin, else the global default. */
  const backendFor = (path: string) => projectBackend(path, settings.agentBackend);

  /** Fetch and cache the project's Claude Code threads (non-blocking). When
   *  silent (pre-warm), failures stay in the console — no toast for a project
   *  the user hasn't opened yet. */
  function refreshThreads(projectId: string, path: string, silent = false) {
    void fetchThreads(projectId, path).catch((e) => {
      console.error("list_threads failed:", e);
      if (!silent) toast.error("Couldn't load threads", { description: String(e) });
    });
  }

  /** List a project's threads once — a whole-directory read — cache the result
   *  for the next launch, and publish it to the project. Concurrent scans for
   *  the same path share the in-flight promise, so the pre-warm's scan and the
   *  reveal's don't each read the directory. Returns null when the backend has
   *  no store of its own to list. */
  const threadScans = useRef(new Map<string, Promise<Thread[]>>());
  function fetchThreads(projectId: string, path: string): Promise<Thread[] | null> {
    const backend = backendFor(path);
    if (!capabilitiesOf(backend).threads) return Promise.resolve(null);
    const inFlight = threadScans.current.get(path);
    if (inFlight) return inFlight;
    const scan = listThreads(backend, path)
      .then((t) => {
        cacheThreads(path, t);
        setThreads(projectId, t);
        return t;
      })
      .finally(() => {
        threadScans.current.delete(path);
      });
    threadScans.current.set(path, scan);
    return scan;
  }

  /** List a thread the moment its pane names it, before any transcript for it
   *  exists on disk. The scan behind `refreshThreads` only sees a thread once
   *  the CLI has written its first turn, which left a chat you are already
   *  talking to missing from the sidebar. The user's own message stands in as
   *  the title until auto-titling replaces it, and the session is pointed at the
   *  thread so resuming it comes back to this pane. */
  function registerThread(
    sessionId: string,
    projectId: string,
    threadId: string,
    firstMessage: string
  ) {
    sessionApi.setSessionThread(sessionId, threadId);
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    if (project.threads.some((t) => t.id === threadId)) return;
    const thread: Thread = {
      id: threadId,
      title: firstMessage.trim().split("\n")[0],
      modified: Date.now(),
    };
    setThreads(projectId, [thread, ...project.threads]);
  }

  /** Launch a project's primary agent: a chat pane resuming the most recent
   *  thread, falling back to a fresh one if there is none / on error.
   *
   *  With a warm thread cache the agent boots without waiting on the directory
   *  scan — the cached list picks the resume target and a background scan
   *  refreshes the list behind the boot. Only a cold cache (first launch,
   *  cleared storage) waits for the scan, so the resume target is the real
   *  latest rather than a guessed one. */
  async function startPrimaryAgent(id: string, path: string): Promise<void> {
    const backend = backendFor(path);
    if (capabilitiesOf(backend).threads) {
      const cached = cachedThreads(path);
      if (cached.length) {
        // Imported threads are history, not a conversation to continue — the
        // agent behind one has no memory of it, so launch never lands there.
        const latest = resumable(cached)[0];
        if (latest) {
          startChat(id, path, latest.id, labelFor(latest), backend);
          // Show the cached list now; the scan refreshes it behind the boot.
          refreshThreads(id, path, true);
          return;
        }
      }
      try {
        const threads = await fetchThreads(id, path);
        if (torndownRef.current.has(id)) return;
        const latest = threads ? resumable(threads)[0] : undefined;
        if (latest) {
          startChat(id, path, latest.id, labelFor(latest), backend);
          return;
        }
      } catch (e) {
        console.error("list_threads failed:", e);
        // Fall through to a fresh agent.
      }
    }
    startChat(id, path, undefined, undefined, backend);
    refreshThreads(id, path, true);
  }

  /** Remove a project and all its sessions (kills their PTYs). */
  function teardownProject(id: string) {
    torndownRef.current.add(id);
    const own = sessionsFor(id);
    for (const s of own) if (s.kind === "dev") void killLog(s.id);
    closeProjectSessions(id);
    useAgentStore.getState().clearSessions(own.map((s) => s.id));
    closeProject(id);
  }

  // ptyLog owns the dev-server processes now — no pane unmount kills them, so
  // every path that removes a dev session must stop its PTY explicitly.
  const closeSessionRef = useRef(sessionApi.closeSession);
  closeSessionRef.current = sessionApi.closeSession;

  function addDev(projectId: string, label: string, cwd: string, command: string) {
    const id = sessionApi.addDev(projectId, label, cwd, command);
    void spawnLog({
      sessionId: id,
      cwd,
      command,
      maxLines: settings.scrollback,
      // A server that exited on its own — drop it so "running" stops lying.
      onExit: () => {
        disposeLog(id);
        closeSessionRef.current(id);
      },
    });
  }

  function closeSession(id: string) {
    if (sessions.find((s) => s.id === id)?.kind === "dev") void killLog(id);
    sessionApi.closeSession(id);
  }

  function stopAllDev(projectId: string) {
    for (const s of sessionsFor(projectId)) {
      if (s.kind === "dev") void killLog(s.id);
    }
    sessionApi.stopAllDev(projectId);
  }

  async function openProjectAt(
    path: string,
    opts?: {
      prewarm?: boolean;
      worktree?: { repoRoot: string; branch: string };
      /** Opened by "new chat": land on a blank thread, never a resumed one. */
      fresh?: boolean;
    }
  ) {
    const prewarm = opts?.prewarm ?? false;
    // Revealing the project the pre-warm already owns: its startPrimaryAgent may
    // still be in flight (awaiting list_threads), so the agent session isn't in
    // state yet — don't start a second one.
    let matchedPrewarm = false;
    if (!prewarm) {
      // A real open reveals the workspace; drop any pre-warmed project that
      // isn't the one being opened.
      const pw = prewarmRef.current;
      prewarmRef.current = null;
      setRevealed(true);
      if (pw) {
        if (pw.path === path) matchedPrewarm = true;
        else teardownProject(pw.id);
      }
    }
    const { id, isNew } = openProject(path, opts?.worktree);
    if (prewarm) prewarmRef.current = { id, path };
    else setRecents(addRecent(path));
    // Seed the sidebar from the last-known list while the real scan runs, so a
    // restored window shows its threads without waiting on the directory read.
    const cached = cachedThreads(path);
    if (cached.length) setThreads(id, cached);
    // Fresh project, or a reopened one whose agent tab had been closed. Skip
    // when the in-flight pre-warm will start the agent itself. startPrimaryAgent
    // owns the thread refresh in every path it runs, so only a plain reopen
    // (agent still up) refreshes here.
    if (opts?.fresh) {
      // The user asked for a new chat, not for this project's latest one — a
      // resumed thread is the opposite of what was requested, even when the
      // project has plenty of them.
      startChat(id, path, undefined, undefined, backendFor(path));
      refreshThreads(id, path, true);
    } else if (!matchedPrewarm && (isNew || !sessionsFor(id).some(isPrimaryAgent))) {
      await startPrimaryAgent(id, path);
    } else if (!matchedPrewarm) {
      refreshThreads(id, path, prewarm);
    }
    if (isNew) {
      invoke<WorkspaceInfo>("scan_workspace", { path })
        .then((w) => setWorkspace(id, w))
        .catch((e) => {
          console.error("scan_workspace failed:", e);
          if (!prewarm)
            toast.error("Couldn't scan workspace", { description: String(e) });
        });
      invoke<string | null>("project_icon", { path })
        .then((icon) => setIcon(id, icon))
        .catch((e) => console.error("project_icon failed:", e));
    }
    return id;
  }

  /** Open a git worktree as its own project, labelled by its branch. Returns
   *  the new project's id so callers can seed it (e.g. run-on-create actions). */
  function openWorktree(path: string, repoRoot: string, branch: string) {
    return openProjectAt(path, { worktree: { repoRoot, branch } });
  }

  /** Reveal a project and focus one of its sessions (used by the palette). */
  function activateSession(projectId: string, sessionId: string) {
    setRevealed(true);
    setActiveProjectId(projectId);
    setActive(projectId, sessionId);
  }

  /** Move a conversation to the other provider, in the same project: reuse that
   *  project's chat on the target backend or open one, focus it, and prefill it
   *  with a context package — the recent turns and their attribution, the
   *  branch/worktree, the instruction files, and the working tree when asked.
   *  Prefilled, never sent: the composer is where the user inspects and edits
   *  the package before the second provider ever sees it. */
  async function handoffFrom({ sourceSessionId, turns, withDiff }: HandoffRequest) {
    const source = sessions.find((s) => s.id === sourceSessionId);
    if (!source) return;
    const from = source.backend ?? "claude";
    const target = otherBackend(from);
    const existing = findHandoffTarget(sessions, source.projectId, target);
    const id =
      existing?.id ??
      startChat(
        source.projectId,
        source.cwd,
        undefined,
        BACKEND_LABEL[target].toLowerCase(),
        target
      );
    // Focus first: gathering the package takes a few round trips, and the user
    // should be looking at the composer it lands in while it fills.
    setRevealed(true);
    setActiveProjectId(source.projectId);
    setActive(source.projectId, id);

    let diff: string | undefined;
    if (withDiff) {
      try {
        diff = await fetchWorkingDiff(source.cwd);
      } catch (e) {
        console.error("git diff for handoff failed:", e);
        toast.error("Couldn't read the working tree", { description: String(e) });
      }
    }
    const [branch, instructions] = await Promise.all([
      fetchBranch(source.cwd),
      fetchInstructions(source.cwd),
    ]);
    const context: HandoffContext = {
      from,
      to: target,
      cwd: source.cwd,
      summary: source.label,
      branch,
      worktree: projects.find((p) => p.id === source.projectId)?.worktree ?? undefined,
      instructions,
      turns,
      diff,
    };
    useAgentStore.getState().setDraft(id, renderHandoffContext(context));
    void recordProviderSwitch(source.id, from, target, id);
    void recordProviderSwitch(id, from, target, source.id);
  }

  // The chat panes reach the handoff through the store rather than a prop —
  // they're memoized, and this closure is new on every render.
  const handoffRef = useRef(handoffFrom);
  handoffRef.current = handoffFrom;
  useEffect(() => {
    useAgentStore
      .getState()
      .setHandoff((request) => void handoffRef.current(request));
  }, []);


  /** Resume a thread in a new chat tab of the given project, revealing and
   *  focusing it. */
  function resumeThreadIn(projectId: string, path: string, thread: Thread) {
    setRevealed(true);
    setActiveProjectId(projectId);
    // A thread that's already open gets focused, not opened again — a second
    // session with the same resume id also breaks the sidebar highlight, which
    // pairs each row with the first matching session.
    const existing = sessionsFor(projectId).find(
      (s) => s.resume === thread.id || s.threadId === thread.id
    );
    if (existing) {
      setActive(projectId, existing.id);
      return;
    }
    startChat(
      projectId,
      path,
      thread.id,
      labelFor(thread),
      backendFor(path),
      thread.imported ?? false
    );
  }

  /** Resume a thread in the active project (ContextBar / Threads menu). */
  function resumeThread(thread: Thread) {
    if (!activeProject) return;
    resumeThreadIn(activeProject.id, activeProject.path, thread);
  }

  async function pickProject(opts?: { fresh?: boolean }) {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string")
      void openProjectAt(selected, { fresh: opts?.fresh });
  }

  /** Spawn a fresh chat tab in the active project. With nothing open yet, pick
   *  a project first and start it on a blank thread. */
  function newAgent() {
    if (!activeProject) {
      void pickProject({ fresh: true });
      return;
    }
    const { id, path } = activeProject;
    startChat(id, path, undefined, undefined, backendFor(path));
  }

  /** Returns false when the user declines to close a project with a live agent. */
  async function closeProjectById(id: string) {
    const statuses = useAgentStore.getState().statuses;
    const busy = sessionsFor(id).some(
      (s) =>
        isPrimaryAgent(s) &&
        (statuses[s.id] === "working" || statuses[s.id] === "waiting")
    );
    if (busy) {
      const ok = await ask(
        "A running agent is active in this project. Close it anyway?",
        { title: "Close project", kind: "warning" }
      );
      if (!ok) return false;
    }
    teardownProject(id);
    if (projects.filter((p) => p.id !== id).length === 0) setRevealed(false);
    return true;
  }

  /** Delete a worktree's directory and its git registration. Anything running
   *  with a cwd inside it is torn down first, or git would race the shells. */
  async function removeWorktree(
    worktreePath: string,
    repoRoot: string,
    force = false
  ) {
    const openProj = projects.find((p) => p.path === worktreePath);
    if (openProj && !(await closeProjectById(openProj.id))) return;

    const attempt = async (f: boolean) => {
      try {
        await invoke("git_worktree_remove", {
          path: repoRoot,
          worktree: worktreePath,
          force: f,
        });
        return null;
      } catch (e) {
        return String(e);
      }
    };

    let err = await attempt(force);
    if (err && !force && /modified|untracked/i.test(err)) {
      const ok = await ask(
        "This worktree has modified or untracked files. Delete it anyway?",
        { title: "Remove worktree", kind: "warning" }
      );
      if (!ok) return;
      err = await attempt(true);
    }
    if (err) {
      toast.error("Couldn't remove worktree", { description: err });
      return;
    }
    // The directory is gone — a stale recent would pre-warm it at next launch.
    setRecents(removeRecent(worktreePath));
    toast.success("Worktree removed");
  }

  /** Reopen last session's projects, active one last so it ends up focused. */
  async function restoreProjects(stored: ReturnType<typeof getOpenProjects>) {
    const ordered = [
      ...stored.projects.filter((p) => p.path !== stored.activePath),
      ...stored.projects.filter((p) => p.path === stored.activePath),
    ];
    for (const p of ordered) {
      await openProjectAt(p.path, { worktree: p.worktree ?? undefined });
    }
  }

  // At launch: restore the projects that were open when the app last quit. With
  // nothing stored, fall back to pre-warming the most-recent project — its agent
  // boots hidden behind the WelcomeScreen so opening it is instant, and it's
  // discarded if the user opens a different project.
  const didPrewarm = useRef(false);
  const didRestore = useRef(false);
  useEffect(() => {
    if (didPrewarm.current) return;
    didPrewarm.current = true;
    didRestore.current = true;
    const stored = getOpenProjects();
    if (stored.projects.length > 0) {
      void restoreProjects(stored);
      return;
    }
    const recent = recents[0];
    // Pre-warming only buys anything when opening would otherwise wait on a
    // thread list; a backend without threads boots straight away.
    if (recent && capabilitiesOf(backendFor(recent)).threads) {
      void openProjectAt(recent, { prewarm: true });
    }
    // Launch-only; openProjectAt/settings are stable enough for a one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the open projects into storage for the next launch. Skipped until
  // the restore above has run, or boot would persist the empty initial list. A
  // pre-warmed project the user never revealed doesn't count as open.
  useEffect(() => {
    if (!didRestore.current) return;
    const open = revealed ? projects : [];
    saveOpenProjects(
      open.map((p) => ({ path: p.path, worktree: p.worktree })),
      open.find((p) => p.id === activeProjectId)?.path ?? null
    );
  }, [projects, activeProjectId, revealed]);

  return {
    ...sessionApi,
    addDev,
    closeSession,
    stopAllDev,
    projects,
    activeProjectId,
    setActiveProjectId,
    activeProject,
    projectSessions,
    activeId,
    revealed,
    recents,
    refreshThreads,
    registerThread,
    openProjectAt,
    openWorktree,
    removeWorktree,
    pickProject,
    newAgent,
    activateSession,
    resumeThread,
    resumeThreadIn,
    closeProjectById,
  };
}
