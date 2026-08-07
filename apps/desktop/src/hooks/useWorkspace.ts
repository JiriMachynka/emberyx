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
  buildHandoffPayload,
  findHandoffTarget,
  otherBackend,
} from "@/lib/handoff";
import { fetchWorkingDiff } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import { getRecents, addRecent, removeRecent } from "@/lib/recents";
import { getOpenProjects, saveOpenProjects } from "@/lib/openProjects";
import { useProjects } from "@/hooks/useProjects";
import { useSessions } from "@/hooks/useSessions";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { useDokploy } from "@/hooks/useDokploy";
import type { Session, Thread, WorkspaceInfo } from "@/types";

/** Thread titles are truncated to this in tab labels. */
const LABEL_MAX = 24;

/** Each backend keeps its own conversation store: Claude's transcripts on
 *  disk, Codex's in its app-server. */
const listThreads = (backend: AgentBackend, cwd: string): Promise<Thread[]> =>
  backend === "codex" ? listCodexThreads(cwd) : invoke<Thread[]>("list_threads", { cwd });

/** The CLI argument that resumes a thread in a terminal session. */
const resumeArg = (backend: AgentBackend, id: string) =>
  backend === "codex" ? `resume ${id}` : `--resume ${id}`;

const labelFor = (thread: Thread) =>
  thread.title.length > LABEL_MAX
    ? `${thread.title.slice(0, LABEL_MAX)}…`
    : thread.title;

/**
 * The app's workspace model: open projects, their sessions, and every action
 * that changes which project or thread is live — opening, pre-warming,
 * resuming, spawning agents, and tearing down. App renders what this returns.
 */
/** A project's primary Claude session, whichever surface it runs on — the
 *  `agentUi` setting decides between a terminal ("agent") and a chat pane
 *  ("chat"), and guards that only look for one silently miss the other. */
const isPrimaryAgent = (s: Session) => s.kind === "agent" || s.kind === "chat";

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
    setDokploy,
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
    startAgent,
    startChat,
    startDokployLogs,
    closeProjectSessions,
    sessionsFor,
  } = sessionApi;

  const { hookSettings, pendingAttention } = useAgentEvents((id) =>
    sessions.find((s) => s.id === id)
  );

  const dokploy = useDokploy({
    url: settings.dokployUrl,
    apiKey: settings.dokployApiKey,
    setMatch: setDokploy,
    openLogs: (projectId, cwd, service) => {
      setRevealed(true);
      setActiveProjectId(projectId);
      startDokployLogs(projectId, cwd, service);
    },
  });

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

  /** Build the agent launch command, injecting hooks + any extra flags. Flags
   *  are Claude Code's own CLI surface, so only Claude gets them. */
  function buildAgentCommand(path: string, extra?: string): string {
    const base = settings.agentCommand;
    const flags: string[] = [];
    if (backendFor(path) === "claude") {
      if (hookSettings) flags.push(`--settings "${hookSettings}"`);
      if (settings.dangerouslySkipPermissions) {
        flags.push("--dangerously-skip-permissions");
      }
      // Full session (default) expands tool output; compact leaves it collapsed.
      if (!settings.compactSession) flags.push("--verbose");
    }
    if (extra) flags.push(extra);
    return flags.length ? `${base} ${flags.join(" ")}` : base;
  }

  /** Fetch and cache the project's Claude Code threads (non-blocking). When
   *  silent (pre-warm), failures stay in the console — no toast for a project
   *  the user hasn't opened yet. */
  function refreshThreads(projectId: string, path: string, silent = false) {
    const backend = backendFor(path);
    if (!capabilitiesOf(backend).threads) return;
    listThreads(backend, path)
      .then((t) => setThreads(projectId, t))
      .catch((e) => {
        console.error("list_threads failed:", e);
        if (!silent) toast.error("Couldn't load threads", { description: String(e) });
      });
  }

  /** Launch a project's primary agent: the chat UI always resumes the most
   *  recent thread; the terminal does so only when the setting is on. Both fall
   *  back to a fresh agent if there is none / on error. Scrollback persists
   *  under the project path either way. */
  async function startPrimaryAgent(id: string, path: string) {
    const chat = settings.agentUi === "chat";
    const backend = backendFor(path);
    // Chat always resumes when it can; the terminal only on the setting.
    const resumeLatest =
      capabilitiesOf(backend).threads && (chat || settings.resumeLatestThread);
    if (resumeLatest) {
      try {
        const threads = await listThreads(backend, path);
        if (torndownRef.current.has(id)) return;
        setThreads(id, threads);
        const latest = [...threads].sort((a, b) => b.modified - a.modified)[0];
        if (latest) {
          const label = labelFor(latest);
          if (chat) {
            startChat(id, path, latest.id, label, backend);
            return;
          }
          startAgent(
            id,
            path,
            buildAgentCommand(path, resumeArg(backend, latest.id)),
            label,
            path,
            backend
          );
          return;
        }
      } catch (e) {
        console.error("list_threads failed:", e);
        // Fall through to a fresh agent.
      }
    }
    if (chat) {
      startChat(id, path, undefined, undefined, backend);
      return;
    }
    startAgent(id, path, buildAgentCommand(path), "agent", path, backend);
  }

  /** Remove a project and all its sessions (kills their PTYs). */
  function teardownProject(id: string) {
    torndownRef.current.add(id);
    const ids = sessionsFor(id).map((s) => s.id);
    closeProjectSessions(id);
    useAgentStore.getState().clearSessions(ids);
    closeProject(id);
  }

  async function openProjectAt(
    path: string,
    opts?: { prewarm?: boolean; worktree?: { repoRoot: string; branch: string } }
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
    // Fresh project, or a reopened one whose agent tab had been closed. Skip
    // when the in-flight pre-warm will start the agent itself.
    if (!matchedPrewarm && (isNew || !sessionsFor(id).some(isPrimaryAgent))) {
      await startPrimaryAgent(id, path);
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
    refreshThreads(id, path, prewarm);
    // Skip the Dokploy network probe for a hidden pre-warmed project; it runs
    // when the user actually reveals it.
    if (!prewarm) dokploy.refresh(id, path);
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

  /** Move a chat message to the other backend, in the same project: reuse that
   *  project's chat on the target backend or open one, prefill its composer,
   *  and focus it. Prefilled, never sent — the user still presses enter. */
  async function handoffFrom(sourceId: string, text: string, withDiff: boolean) {
    const source = sessions.find((s) => s.id === sourceId);
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
    let diff: string | undefined;
    if (withDiff) {
      try {
        diff = await fetchWorkingDiff(source.cwd);
      } catch (e) {
        console.error("git diff for handoff failed:", e);
        toast.error("Couldn't read the working tree", { description: String(e) });
      }
    }
    useAgentStore.getState().setDraft(id, buildHandoffPayload(from, text, diff));
    setRevealed(true);
    setActiveProjectId(source.projectId);
    setActive(source.projectId, id);
  }

  // The chat panes reach the handoff through the store rather than a prop —
  // they're memoized, and this closure is new on every render.
  const handoffRef = useRef(handoffFrom);
  handoffRef.current = handoffFrom;
  useEffect(() => {
    useAgentStore
      .getState()
      .setHandoff((id, text, withDiff) => void handoffRef.current(id, text, withDiff));
  }, []);

  /** Resume a Claude Code thread in a new tab of the given project, revealing
   *  and focusing it. Uses the default surface (chat / terminal). */
  function resumeThreadIn(projectId: string, path: string, thread: Thread) {
    setRevealed(true);
    setActiveProjectId(projectId);
    const label = labelFor(thread);
    const backend = backendFor(path);
    if (settings.agentUi === "chat") {
      startChat(projectId, path, thread.id, label, backend);
      return;
    }
    startAgent(
      projectId,
      path,
      buildAgentCommand(path, resumeArg(backend, thread.id)),
      label,
      undefined,
      backend
    );
  }

  /** Resume a thread in the active project (ContextBar / Threads menu). */
  function resumeThread(thread: Thread) {
    if (!activeProject) return;
    resumeThreadIn(activeProject.id, activeProject.path, thread);
  }

  async function pickProject() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") void openProjectAt(selected);
  }

  /** Spawn a fresh agent tab in the active project, using the default surface. */
  function newAgent() {
    if (!activeProject) return;
    const { id, path } = activeProject;
    const backend = backendFor(path);
    if (settings.agentUi === "chat") {
      startChat(id, path, undefined, undefined, backend);
      return;
    }
    startAgent(id, path, buildAgentCommand(path), undefined, undefined, backend);
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

  // When the window regains focus (e.g. clicking the desktop notification),
  // jump to the session that raised it if it's still waiting.
  useEffect(() => {
    function onFocus() {
      const sid = pendingAttention.current;
      if (!sid) return;
      pendingAttention.current = null;
      const sess = sessions.find((s) => s.id === sid);
      if (sess && useAgentStore.getState().statuses[sid] === "waiting") {
        setActiveProjectId(sess.projectId);
        setActive(sess.projectId, sid);
      }
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sessions, setActiveProjectId, setActive, pendingAttention]);

  return {
    ...sessionApi,
    projects,
    activeProjectId,
    setActiveProjectId,
    activeProject,
    projectSessions,
    activeId,
    revealed,
    recents,
    dokploy,
    refreshThreads,
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
