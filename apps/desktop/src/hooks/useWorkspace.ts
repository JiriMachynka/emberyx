import { useEffect, useMemo, useRef, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { isClaudeAgent, type Settings } from "@/lib/settings";
import { useAgentStore } from "@/lib/agentStore";
import { getRecents, addRecent, removeRecent } from "@/lib/recents";
import { useProjects } from "@/hooks/useProjects";
import { useSessions } from "@/hooks/useSessions";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { useDokploy } from "@/hooks/useDokploy";
import type { Thread, WorkspaceInfo } from "@/types";

/** Thread titles are truncated to this in tab labels. */
const LABEL_MAX = 24;

const labelFor = (thread: Thread) =>
  thread.title.length > LABEL_MAX
    ? `${thread.title.slice(0, LABEL_MAX)}…`
    : thread.title;

/**
 * The app's workspace model: open projects, their sessions, and every action
 * that changes which project or thread is live — opening, pre-warming,
 * resuming, spawning agents, and tearing down. App renders what this returns.
 */
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

  // Latest projects list for async guards: a superseded pre-warm must not
  // resurrect a torn-down project's session after its list_threads resolves.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

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

  /** Build the agent launch command, injecting hooks + any extra flags. */
  function buildAgentCommand(extra?: string): string {
    const base = settings.agentCommand;
    const flags: string[] = [];
    if (isClaudeAgent(base)) {
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
    invoke<Thread[]>("list_threads", { cwd: path })
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
    // Chat is always Claude, so agentCommand only gates the terminal path.
    const resumeLatest =
      chat || (settings.resumeLatestThread && isClaudeAgent(settings.agentCommand));
    if (resumeLatest) {
      try {
        const threads = await invoke<Thread[]>("list_threads", { cwd: path });
        // A superseded pre-warm may have been torn down while we awaited; don't
        // resurrect its session (which would orphan a PTY).
        if (!projectsRef.current.some((p) => p.id === id)) return;
        setThreads(id, threads);
        const latest = [...threads].sort((a, b) => b.modified - a.modified)[0];
        if (latest) {
          const label = labelFor(latest);
          if (chat) {
            startChat(id, path, latest.id, label);
            return;
          }
          startAgent(id, path, buildAgentCommand(`--resume ${latest.id}`), label, path);
          return;
        }
      } catch (e) {
        console.error("list_threads failed:", e);
        // Fall through to a fresh agent.
      }
    }
    if (chat) {
      startChat(id, path);
      return;
    }
    startAgent(id, path, buildAgentCommand(), "agent", path);
  }

  /** Remove a project and all its sessions (kills their PTYs). */
  function teardownProject(id: string) {
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
    if (
      !matchedPrewarm &&
      (isNew || !sessionsFor(id).some((s) => s.kind === "agent"))
    ) {
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
  }

  /** Open a git worktree as its own project, labelled by its branch. */
  function openWorktree(path: string, repoRoot: string, branch: string) {
    return openProjectAt(path, { worktree: { repoRoot, branch } });
  }

  /** Reveal a project and focus one of its sessions (used by the palette). */
  function activateSession(projectId: string, sessionId: string) {
    setRevealed(true);
    setActiveProjectId(projectId);
    setActive(projectId, sessionId);
  }

  /** Resume a Claude Code thread in a new tab of the given project, revealing
   *  and focusing it. Uses the default surface (chat / terminal). */
  function resumeThreadIn(projectId: string, path: string, thread: Thread) {
    setRevealed(true);
    setActiveProjectId(projectId);
    const label = labelFor(thread);
    if (settings.agentUi === "chat") {
      startChat(projectId, path, thread.id, label);
      return;
    }
    startAgent(projectId, path, buildAgentCommand(`--resume ${thread.id}`), label);
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
    if (settings.agentUi === "chat") {
      startChat(activeProject.id, activeProject.path);
      return;
    }
    startAgent(activeProject.id, activeProject.path, buildAgentCommand());
  }

  /** Returns false when the user declines to close a project with a live agent. */
  async function closeProjectById(id: string) {
    const statuses = useAgentStore.getState().statuses;
    const busy = sessionsFor(id).some(
      (s) =>
        s.kind === "agent" &&
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

  // Pre-warm the most-recent project once at launch: its agent boots hidden
  // behind the WelcomeScreen so opening it is instant. Discarded if the user
  // opens a different project.
  const didPrewarm = useRef(false);
  useEffect(() => {
    if (didPrewarm.current) return;
    didPrewarm.current = true;
    const recent = recents[0];
    if (recent && isClaudeAgent(settings.agentCommand)) {
      void openProjectAt(recent, { prewarm: true });
    }
    // Launch-only; openProjectAt/settings are stable enough for a one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
