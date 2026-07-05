import { useEffect, useMemo, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Toaster, toast } from "sonner";
import { TerminalPane } from "@/components/TerminalPane";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { HeaderBar } from "@/components/HeaderBar";
import { ProjectTabStrip } from "@/components/ProjectTabStrip";
import { SessionTabStrip } from "@/components/SessionTabStrip";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { AttentionBanner } from "@/components/AttentionBanner";
import { cn } from "@/lib/utils";
import { statusOf } from "@/lib/status";
import { useSettings, isClaudeAgent } from "@/lib/settings";
import { getRecents, addRecent } from "@/lib/recents";
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
  const [recents, setRecents] = useState<string[]>(getRecents);
  const { settings, update: updateSettings } = useSettings();

  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    openProject,
    setWorkspace,
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

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const projectSessions = useMemo(
    () => (activeProjectId ? sessionsFor(activeProjectId) : []),
    // sessionsFor derives from `sessions`; recompute only when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, activeProjectId]
  );
  const activeId = activeProjectId
    ? activeByProject[activeProjectId] ?? null
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

  function openProjectAt(path: string) {
    const { id, isNew } = openProject(path);
    setRecents(addRecent(path));
    if (isNew) {
      // Primary agent: persist its scrollback under the project path.
      startAgent(id, path, buildAgentCommand(), "agent", path);
      invoke<WorkspaceInfo>("scan_workspace", { path })
        .then((w) => setWorkspace(id, w))
        .catch((e) => {
          console.error("scan_workspace failed:", e);
          toast.error("Couldn't scan workspace", { description: String(e) });
        });
    } else if (!sessionsFor(id).some((s) => s.kind === "agent")) {
      // Reopened, but its agent tab had been closed — relaunch one.
      startAgent(id, path, buildAgentCommand(), "agent", path);
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

  useShortcuts({ onOpen: pickProject, onNewAgent: newAgent });

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

  const showTabs = projectSessions.length > 1;
  // Header reflects the active tab when it's an agent, else the first agent —
  // so multiple resumed threads each drive the header when focused.
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
    <div className="flex h-full flex-col bg-background text-foreground">
      <HeaderBar
        activeProject={activeProject}
        claudeAgent={isClaudeAgent(settings.agentCommand)}
        agent={agent}
        agentStatus={agentStatus}
        agentUsage={agentUsage}
        devRunning={projectSessions.some((s) => s.kind === "dev")}
        changesCount={projectChanges.length}
        changesOpen={changesOpen}
        onRefreshThreads={() => {
          if (activeProject) refreshThreads(activeProject.id, activeProject.path);
        }}
        onResumeThread={resumeThread}
        onRefreshDokploy={() => {
          if (activeProject) refreshDokploy(activeProject.id, activeProject.path);
        }}
        onRunPackage={runPackage}
        onRunAll={runAll}
        onStopDev={() => {
          if (activeProjectId) stopAllDev(activeProjectId);
        }}
        onNewAgent={newAgent}
        onToggleChanges={() => setChangesOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {projects.length > 0 && (
        <ProjectTabStrip
          projects={projects}
          activeProjectId={activeProjectId}
          statuses={statuses}
          sessionsFor={sessionsFor}
          onSelect={setActiveProjectId}
          onClose={handleCloseProject}
          onPick={pickProject}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onUpdate={updateSettings}
      />

      <Toaster theme="dark" position="bottom-right" richColors closeButton />

      {agent && agentStatus === "waiting" && activeProjectId && (
        <AttentionBanner onJump={() => setActive(activeProjectId, agent.id)} />
      )}

      {/* Terminal viewport + changes panel */}
      <div className="flex min-h-0 flex-1">
        <main className="relative flex-1 bg-[#1a1a1e] p-1">
          {projects.length > 0 ? (
            sessions.map((s) => (
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
            ))
          ) : (
            <WelcomeScreen
              recents={recents}
              onPick={pickProject}
              onOpenRecent={openProjectAt}
            />
          )}
        </main>
        {activeProject && changesOpen && (
          <ChangesPanel
            projectPath={activeProject.path}
            changes={projectChanges}
            onClose={() => setChangesOpen(false)}
          />
        )}
      </div>

      {showTabs && activeProjectId && (
        <SessionTabStrip
          sessions={projectSessions}
          activeId={activeId}
          activeProjectId={activeProjectId}
          statuses={statuses}
          onSelect={(id) => setActive(activeProjectId, id)}
          onClose={closeSession}
          onMove={moveSession}
        />
      )}
    </div>
  );
}

export default App;
