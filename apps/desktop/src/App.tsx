import { useEffect, useMemo, useRef, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Toaster, toast } from "sonner";
import { TerminalPane } from "@/components/TerminalPane";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { ContextBar } from "@/components/ContextBar";
import { Sidebar } from "@/components/Sidebar";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { AttentionBanner } from "@/components/AttentionBanner";
import { cn } from "@/lib/utils";
import { statusOf } from "@/lib/status";
import { useSettings, isClaudeAgent } from "@/lib/settings";
import { getRecents, addRecent } from "@/lib/recents";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { checkForUpdates } from "@/lib/update";
import { useSessions } from "@/hooks/useSessions";
import { useProjects } from "@/hooks/useProjects";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import { useShortcuts } from "@/hooks/useShortcuts";
import type {
  DokployMatch,
  PackageInfo,
  SessionStatus,
  Thread,
  WorkspaceInfo,
} from "@/types";

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [sidebarCollapsed, setCollapsed] = useState<boolean>(getSidebarCollapsed);
  const [recents, setRecents] = useState<string[]>(getRecents);

  function toggleSidebar() {
    setCollapsed((c) => {
      setSidebarCollapsed(!c);
      return !c;
    });
  }
  const { settings, update: updateSettings } = useSettings();

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

  const {
    sessions,
    activeByProject,
    setActive,
    startAgent,
    addDev,
    closeSession,
    moveSession,
    stopAllDev,
    closeProjectSessions,
    sessionsFor,
  } = useSessions();

  const {
    statuses,
    changes,
    usages,
    hookSettings,
    pendingAttention,
    clearSessions,
  } = useAgentEvents((id) => sessions.find((s) => s.id === id));

  // The most-recent project is pre-warmed (its agent booted) hidden behind the
  // WelcomeScreen at launch, so opening it is instant. Until the user reveals a
  // project, the UI treats nothing as active — the pre-warm pane stays mounted
  // (so it boots) but hidden.
  const [revealed, setRevealed] = useState(false);
  const prewarmRef = useRef<{ id: string; path: string } | null>(null);
  const uiActiveProjectId = revealed ? activeProjectId : null;

  const activeProject =
    projects.find((p) => p.id === uiActiveProjectId) ?? null;
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

  /** Fetch and cache the project's Claude Code threads (non-blocking). */
  function refreshThreads(projectId: string, path: string) {
    invoke<Thread[]>("list_threads", { cwd: path })
      .then((t) => setThreads(projectId, t))
      .catch((e) => {
        console.error("list_threads failed:", e);
        toast.error("Couldn't load threads", { description: String(e) });
      });
  }

  /** Match the project against Dokploy by git remote, caching the result. */
  function refreshDokploy(projectId: string, path: string) {
    if (!settings.dokployUrl || !settings.dokployApiKey) return;
    invoke<DokployMatch | null>("dokploy_services", {
      url: settings.dokployUrl,
      apiKey: settings.dokployApiKey,
      cwd: path,
    })
      .then((m) => setDokploy(projectId, m))
      .catch((e) => {
        console.error("dokploy_services failed:", e);
        toast.error("Couldn't reach Dokploy", { description: String(e) });
      });
  }

  /** Launch a project's primary agent: resume its most recent thread when the
   *  setting is on (falling back to a fresh agent if none / on error), else a
   *  brand-new agent. Scrollback persists under the project path either way. */
  async function startPrimaryAgent(id: string, path: string) {
    if (settings.resumeLatestThread && isClaudeAgent(settings.agentCommand)) {
      try {
        const threads = await invoke<Thread[]>("list_threads", { cwd: path });
        setThreads(id, threads);
        const latest = [...threads].sort((a, b) => b.modified - a.modified)[0];
        if (latest) {
          const label =
            latest.title.length > 24
              ? `${latest.title.slice(0, 24)}…`
              : latest.title;
          startAgent(
            id,
            path,
            buildAgentCommand(`--resume ${latest.id}`),
            label,
            path
          );
          return;
        }
      } catch (e) {
        console.error("list_threads failed:", e);
        // Fall through to a fresh agent.
      }
    }
    startAgent(id, path, buildAgentCommand(), "agent", path);
  }

  /** Tear down a pre-warmed project the user never opened. */
  function discardPrewarm(id: string) {
    const ids = sessionsFor(id).map((s) => s.id);
    closeProjectSessions(id);
    clearSessions(ids);
    closeProject(id);
  }

  async function openProjectAt(path: string, opts?: { prewarm?: boolean }) {
    const prewarm = opts?.prewarm ?? false;
    if (!prewarm) {
      // A real open reveals the workspace; drop any pre-warmed project that
      // isn't the one being opened.
      const pw = prewarmRef.current;
      prewarmRef.current = null;
      setRevealed(true);
      if (pw && pw.path !== path) discardPrewarm(pw.id);
    }
    const { id, isNew } = openProject(path);
    if (prewarm) prewarmRef.current = { id, path };
    else setRecents(addRecent(path));
    // Fresh project, or a reopened one whose agent tab had been closed.
    if (isNew || !sessionsFor(id).some((s) => s.kind === "agent")) {
      await startPrimaryAgent(id, path);
    }
    if (isNew) {
      invoke<WorkspaceInfo>("scan_workspace", { path })
        .then((w) => setWorkspace(id, w))
        .catch((e) => {
          console.error("scan_workspace failed:", e);
          toast.error("Couldn't scan workspace", { description: String(e) });
        });
      invoke<string | null>("project_icon", { path })
        .then((icon) => setIcon(id, icon))
        .catch((e) => console.error("project_icon failed:", e));
    }
    refreshThreads(id, path);
    refreshDokploy(id, path);
  }

  /** Resume a Claude Code thread in a new agent tab. */
  function resumeThread(thread: Thread) {
    if (!activeProjectId || !activeProject) return;
    const label =
      thread.title.length > 24 ? `${thread.title.slice(0, 24)}…` : thread.title;
    startAgent(
      activeProjectId,
      activeProject.path,
      buildAgentCommand(`--resume ${thread.id}`),
      label
    );
  }

  async function pickProject() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") openProjectAt(selected);
  }

  /** Spawn a fresh (secondary) agent tab in the active project. */
  function newAgent() {
    if (!activeProjectId || !activeProject) return;
    startAgent(activeProjectId, activeProject.path, buildAgentCommand());
  }

  async function handleCloseProject(id: string) {
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
      if (!ok) return;
    }
    const ids = sessionsFor(id).map((s) => s.id);
    closeProjectSessions(id);
    clearSessions(ids);
    closeProject(id);
    // Back to the WelcomeScreen once the last project is gone.
    if (projects.filter((p) => p.id !== id).length === 0) setRevealed(false);
  }

  function runPackage(pkg: PackageInfo) {
    if (!activeProjectId) return;
    addDev(activeProjectId, pkg.name, pkg.path, pkg.devCommand);
  }

  function runAll() {
    if (!activeProject || !activeProjectId) return;
    const ws = activeProject.workspace;
    if (!ws) return;
    if (ws.allCommand) {
      addDev(activeProjectId, "all", activeProject.path, ws.allCommand);
    } else {
      ws.packages.forEach((p) =>
        addDev(activeProjectId, p.name, p.path, p.devCommand)
      );
    }
  }

  useShortcuts({
    onOpen: pickProject,
    onNewAgent: newAgent,
    onToggleSidebar: toggleSidebar,
  });

  // Check for a newer signed release on launch (quiet on failure).
  useEffect(() => {
    void checkForUpdates({ silent: true });
  }, []);

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
      if (sess && statuses[sid] === "waiting") {
        setActiveProjectId(sess.projectId);
        setActive(sess.projectId, sid);
      }
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [sessions, statuses, setActiveProjectId, setActive, pendingAttention]);

  // The context bar reflects the active tab when it's an agent, else the first
  // agent — so multiple resumed threads each drive it when focused.
  const firstAgent = projectSessions.find((s) => s.kind === "agent");
  const activeSession = projectSessions.find((s) => s.id === activeId);
  const agent = activeSession?.kind === "agent" ? activeSession : firstAgent;
  const agentStatus: SessionStatus = agent ? statusOf(statuses, agent.id) : "idle";
  const agentUsage = agent ? usages[agent.id] : undefined;
  const projectChanges = useMemo(
    () => changes.filter((c) => projectSessions.some((s) => s.id === c.session)),
    [changes, projectSessions]
  );

  return (
    <div className="flex h-full bg-background text-foreground">
      {revealed && projects.length > 0 && (
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeByProject={activeByProject}
          statuses={statuses}
          sessionsFor={sessionsFor}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onSelectProject={setActiveProjectId}
          onCloseProject={handleCloseProject}
          onPickProject={pickProject}
          onSelectSession={setActive}
          onCloseSession={closeSession}
          onMoveSession={moveSession}
          onNewAgent={newAgent}
          onRefreshDokploy={() => {
            if (activeProject) refreshDokploy(activeProject.id, activeProject.path);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ContextBar
          activeProject={activeProject}
          agent={agent}
          agentStatus={agentStatus}
          agentUsage={agentUsage}
          claudeAgent={isClaudeAgent(settings.agentCommand)}
          devRunning={projectSessions.some((s) => s.kind === "dev")}
          changesCount={projectChanges.length}
          changesOpen={changesOpen}
          onRunPackage={runPackage}
          onRunAll={runAll}
          onStopDev={() => {
            if (activeProjectId) stopAllDev(activeProjectId);
          }}
          onRefreshThreads={() => {
            if (activeProject) refreshThreads(activeProject.id, activeProject.path);
          }}
          onResumeThread={resumeThread}
          onToggleChanges={() => setChangesOpen((v) => !v)}
        />

        {agent && agentStatus === "waiting" && activeProjectId && (
          <AttentionBanner onJump={() => setActive(activeProjectId, agent.id)} />
        )}

        {/* Terminal viewport + changes panel */}
        <div className="flex min-h-0 flex-1">
          <main className="canvas-lit relative flex-1 p-1">
            {/* Panes stay mounted once a session exists, so a pre-warmed
                project boots in the background. Hidden unless it's the active,
                revealed tab. */}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "absolute inset-1",
                  s.id === activeId ? "" : "hidden"
                )}
              >
                <TerminalPane
                  sessionId={s.id}
                  cwd={s.cwd}
                  command={s.command}
                  persistKey={s.persistKey}
                  fontFamily={settings.fontFamily}
                  fontSize={settings.fontSize}
                  scrollback={settings.scrollback}
                  active={s.id === activeId}
                />
              </div>
            ))}
            {!revealed && (
              <div className="canvas-lit absolute inset-0">
                <WelcomeScreen
                  recents={recents}
                  onPick={pickProject}
                  onOpenRecent={openProjectAt}
                />
              </div>
            )}
          </main>
          {activeProject && changesOpen && (
            <ChangesPanel
              projectPath={activeProject.path}
              changes={projectChanges}
              openRouterApiKey={settings.openRouterApiKey}
              openRouterModel={settings.openRouterModel}
              onClose={() => setChangesOpen(false)}
            />
          )}
        </div>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onUpdate={updateSettings}
      />

      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  );
}

export default App;
