import { useMemo, useState } from "react";
import { Toaster } from "sonner";
import { SessionPanes } from "@/components/SessionPanes";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { DevPanel } from "@/components/DevPanel";
import { ContextBar } from "@/components/ContextBar";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { UsagePanel } from "@/components/UsagePanel";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { AttentionBanner } from "@/components/AttentionBanner";
import { cn } from "@/lib/utils";
import { useSettings, isClaudeAgent } from "@/lib/settings";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { requestSearch } from "@/lib/searchRequest";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useDevServers } from "@/hooks/useDevServers";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useLaunchUpdateCheck } from "@/hooks/useLaunchUpdateCheck";

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  // Keep the Changes panel mounted while its exit animation plays (~200ms).
  const [changesClosing, setChangesClosing] = useState(false);
  const [sidebarCollapsed, setCollapsed] = useState<boolean>(getSidebarCollapsed);

  const closeChanges = () => {
    setChangesClosing(true);
    window.setTimeout(() => {
      setChangesOpen(false);
      setChangesClosing(false);
    }, 200);
  };

  const toggleChanges = () => {
    if (changesOpen) closeChanges();
    else setChangesOpen(true);
  };

  function toggleSidebar() {
    setCollapsed((c) => {
      setSidebarCollapsed(!c);
      return !c;
    });
  }

  const { settings, update: updateSettings } = useSettings();
  const ws = useWorkspace(settings);
  const {
    projects,
    sessions,
    activeProject,
    activeProjectId,
    activeId,
    projectSessions,
    revealed,
    recents,
    dokploy,
  } = ws;
  const dev = useDevServers(activeProject, ws.addDev);

  const openSearch = () => {
    if (!activeProject) return;
    requestSearch();
    ws.startEditor(activeProject.id, activeProject.path);
  };

  useShortcuts({
    onOpen: ws.pickProject,
    onNewAgent: ws.newAgent,
    onToggleSidebar: toggleSidebar,
    onCommandPalette: () => setPaletteOpen((v) => !v),
    onSearch: openSearch,
  });
  useLaunchUpdateCheck();

  // The context bar reflects the active tab when it's an agent, else the first
  // agent — so multiple resumed threads each drive it when focused.
  const firstAgent = projectSessions.find((s) => s.kind === "agent");
  const activeSession = projectSessions.find((s) => s.id === activeId);
  const agent = activeSession?.kind === "agent" ? activeSession : firstAgent;
  const projectSessionIds = useMemo(
    () => projectSessions.map((s) => s.id),
    [projectSessions]
  );
  // Dev servers render in the right-hand panel, never as sidebar tabs.
  const devSessions = useMemo(
    () => sessions.filter((s) => s.kind === "dev"),
    [sessions]
  );
  const devCount = devSessions.filter(
    (s) => s.projectId === activeProject?.id
  ).length;

  return (
    <div className="flex h-full bg-background text-foreground">
      {revealed && projects.length > 0 && (
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeByProject={ws.activeByProject}
          sessionsFor={ws.sessionsFor}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onSelectProject={ws.setActiveProjectId}
          onCloseProject={ws.closeProjectById}
          onPickProject={ws.pickProject}
          onSelectSession={ws.setActive}
          onCloseSession={ws.closeSession}
          onMoveSession={ws.moveSession}
          onNewAgent={ws.newAgent}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ContextBar
          activeProject={activeProject}
          agent={agent}
          claudeAgent={isClaudeAgent(settings.agentCommand)}
          devRunning={projectSessions.some((s) => s.kind === "dev")}
          sessionIds={projectSessionIds}
          changesOpen={changesOpen}
          devOpen={devOpen}
          devCount={devCount}
          onToggleDev={() => setDevOpen((v) => !v)}
          customDevCommand={dev.customCommand}
          onSetCustomDevCommand={dev.setCustomCommand}
          onRunCustomDev={dev.runCustom}
          onRunPackage={dev.runPackage}
          onRunAll={dev.runAll}
          onStopDev={() => {
            if (activeProjectId) ws.stopAllDev(activeProjectId);
          }}
          onRefreshThreads={() => {
            if (activeProject) ws.refreshThreads(activeProject.id, activeProject.path);
          }}
          onResumeThread={ws.resumeThread}
          onToggleChanges={toggleChanges}
          onOpenUsage={() => setUsageOpen(true)}
          onOpenEditor={() => {
            if (activeProject) ws.startEditor(activeProject.id, activeProject.path);
          }}
          onRefreshDokploy={() => {
            if (activeProject) dokploy.refresh(activeProject.id, activeProject.path);
          }}
          onRedeployDokploy={dokploy.redeploy}
          onViewDokployLogs={(service) => {
            if (activeProject) dokploy.viewLogs(activeProject, service);
          }}
        />

        {agent && activeProjectId && (
          <AttentionBanner
            agentId={agent.id}
            onJump={() => ws.setActive(activeProjectId, agent.id)}
          />
        )}

        {/* Terminal viewport + changes panel */}
        <div className="flex min-h-0 flex-1">
          <main className="canvas-lit relative flex-1 p-1">
            {/* Panes stay mounted once a session exists, so a pre-warmed
                project boots in the background. Hidden unless it's the active,
                revealed tab. */}
            <SessionPanes
              sessions={sessions}
              activeId={activeId}
              settings={settings}
              onTitled={(session, title) => {
                ws.renameSession(session.id, title);
                ws.refreshThreads(session.projectId, session.cwd, true);
              }}
            />
            {!revealed && (
              <div className="canvas-lit absolute inset-0">
                <WelcomeScreen
                  recents={recents}
                  onPick={ws.pickProject}
                  onOpenRecent={ws.openProjectAt}
                />
              </div>
            )}
          </main>
          {/* Always mounted: the panes inside own the running dev PTYs. */}
          <DevPanel
            sessions={devSessions}
            projectId={activeProject?.id ?? null}
            open={devOpen}
            fontFamily={settings.fontFamily}
            fontSize={settings.fontSize}
            scrollback={settings.scrollback}
            onStop={ws.closeSession}
            onClose={() => setDevOpen(false)}
          />
          {activeProject && (changesOpen || changesClosing) && (
            <div
              className={cn(
                "flex shrink-0 duration-200",
                changesClosing
                  ? "animate-out fade-out slide-out-to-right-4"
                  : "animate-in fade-in slide-in-from-right-4"
              )}
            >
              <ChangesPanel
                projectPath={activeProject.path}
                sessionIds={projectSessionIds}
                openRouterApiKey={settings.openRouterApiKey}
                openRouterModel={settings.openRouterModel}
                onClose={closeChanges}
              />
            </div>
          )}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={sessions}
        projects={projects}
        chatUi={settings.agentUi === "chat"}
        onSelectSession={ws.activateSession}
        onResumeThread={ws.resumeThreadIn}
        onNewAgent={ws.newAgent}
        onPickProject={ws.pickProject}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleChanges={toggleChanges}
        onSearch={openSearch}
        onOpenUsage={() => setUsageOpen(true)}
      />

      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}

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
