import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Toaster } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SessionPanes } from "@/components/SessionPanes";
import { SidePanel } from "@/components/SidePanel";
import { ProjectSettingsPane } from "@/components/ProjectSettingsPane";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { MergeRequestsPanel } from "@/components/MergeRequestsPanel";
import { NotificationPanel } from "@/components/NotificationPanel";
import { DevPanel } from "@/components/DevPanel";
import { ContextBar } from "@/components/ContextBar";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { UsagePanel } from "@/components/UsagePanel";
import { SlashCommandsPanel } from "@/components/SlashCommandsPanel";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { AttentionBanner } from "@/components/AttentionBanner";
import { AccountBanner } from "@/components/AccountBanner";
import { cn } from "@/lib/utils";
import { useSettings, isClaudeAgent } from "@/lib/settings";
import { useAgentStore, selectUnreadCount } from "@/lib/agentStore";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { requestSearch } from "@/lib/searchRequest";
import { projectLabel } from "@/lib/worktree";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useDevServers } from "@/hooks/useDevServers";
import { useProjectActions } from "@/hooks/useProjectActions";
import { ActionDialog } from "@/components/ActionDialog";
import { getStoredActions, type ProjectAction } from "@/lib/actions";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useLaunchUpdateCheck } from "@/hooks/useLaunchUpdateCheck";
import { usePricingRefresh } from "@/hooks/usePricingRefresh";

// CodeMirror is a big chunk; only sessions that open the editor pay for it.
// Three CodeMirror instances plus the merge machinery — only pay for it when a
// merge actually stops on conflicts.
const ConflictView = lazy(() =>
  import("@/components/ConflictView").then((m) => ({ default: m.ConflictView }))
);
const EditorPane = lazy(() =>
  import("@/components/EditorPane").then((m) => ({ default: m.EditorPane }))
);
const SurfacePanel = lazy(() => import("@/components/SurfacePanel"));

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  // Lazily mounted on first open, then kept mounted and merely hidden — the
  // terminals inside own live shells that closing must not kill.
  const [surfaceMounted, setSurfaceMounted] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [mrsOpen, setMrsOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Once opened the editor stays mounted and is merely hidden, so open buffers,
  // scroll position and undo history survive closing it.
  const [editorMounted, setEditorMounted] = useState(false);
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

  // Only one right-hand panel is visible at a time — opening any closes the rest.
  const closeRightPanels = () => {
    setSurfaceOpen(false);
    setDevOpen(false);
    setMrsOpen(false);
    setProjectSettingsOpen(false);
    if (changesOpen) closeChanges();
  };

  const toggleChanges = () => {
    if (changesOpen) closeChanges();
    else {
      closeRightPanels();
      setChangesOpen(true);
    }
  };

  const toggleSurface = () => {
    if (surfaceOpen) setSurfaceOpen(false);
    else {
      closeRightPanels();
      setSurfaceMounted(true);
      setSurfaceOpen(true);
    }
  };

  const toggleDev = () => {
    if (devOpen) setDevOpen(false);
    else {
      closeRightPanels();
      setDevOpen(true);
    }
  };

  const toggleMrs = () => {
    if (mrsOpen) setMrsOpen(false);
    else {
      closeRightPanels();
      setMrsOpen(true);
    }
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

  // Project-scoped panels close when switching projects, so a panel opened
  // for one project doesn't linger empty over the next.
  useEffect(() => {
    setChangesOpen(false);
    setDevOpen(false);
    setMrsOpen(false);
    setProjectSettingsOpen(false);
  }, [activeProjectId]);

  const dev = useDevServers(activeProject, ws.addDev);
  const projectActions = useProjectActions(activeProject);
  const [actionEdit, setActionEdit] = useState<{
    action: ProjectAction | null;
  } | null>(null);
  // Run an action's command as an output session; reveal the panel on the setting.
  const runAction = (a: ProjectAction) => {
    if (!activeProject) return;
    ws.addDev(activeProject.id, a.name, activeProject.path, a.command);
    if (settings.autoOpenDevPanel) {
      closeRightPanels();
      setDevOpen(true);
    }
  };
  // Open a new worktree, then fire the source project's run-on-create actions.
  const openWorktreeAndRun = async (
    path: string,
    repoRoot: string,
    branch: string
  ) => {
    const id = await ws.openWorktree(path, repoRoot, branch);
    const auto = (getStoredActions(repoRoot) ?? []).filter(
      (a) => a.runOnWorktreeCreate
    );
    for (const a of auto) ws.addDev(id, a.name, path, a.command);
  };
  const unread = useAgentStore(selectUnreadCount);
  const markNotificationsRead = useAgentStore((s) => s.markNotificationsRead);

  // Mirror unread onto the macOS dock badge. Guarded — there's no window in
  // tests or a plain browser.
  useEffect(() => {
    try {
      void getCurrentWindow()
        .setBadgeCount(unread > 0 ? unread : undefined)
        .catch(() => {});
    } catch {
      // Not running under Tauri.
    }
  }, [unread]);

  const toggleNotifications = () => {
    if (!notificationsOpen) markNotificationsRead();
    setNotificationsOpen(!notificationsOpen);
  };

  const jumpToSession = (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId);
    if (target) ws.activateSession(target.projectId, target.id);
  };

  // Signing in is interactive (browser hand-off, then a code pasted back), so
  // it runs in a real terminal tab. `/login` is a REPL slash command that can't
  // be reached from outside the pane; `claude auth login` is the same flow as a
  // command. The binary comes from the configured agent command so a wrapper or
  // absolute path still resolves.
  const startLogin = () => {
    if (!activeProject) return;
    const bin = isClaudeAgent(settings.agentCommand)
      ? settings.agentCommand.split(" ")[0]
      : "claude";
    ws.startAgent(activeProject.id, activeProject.path, `${bin} auth login`, "login");
  };

  const openProjectSettings = () => {
    if (!activeProject) return;
    closeRightPanels();
    setProjectSettingsOpen(true);
  };

  const openEditor = () => {
    if (!activeProject) return;
    setEditorMounted(true);
    setEditorOpen(true);
  };

  const openSearch = () => {
    // requestSearch first: a mounting editor consumes the pending flag, an
    // already-open one gets the event.
    requestSearch();
    openEditor();
  };

  // Esc closes the editor overlay, unless a child (the file finder) claimed it.
  useEffect(() => {
    if (!editorOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) setEditorOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  useShortcuts({
    onOpen: ws.pickProject,
    onNewAgent: ws.newAgent,
    onToggleSidebar: toggleSidebar,
    onCommandPalette: () => setPaletteOpen((v) => !v),
    onSearch: openSearch,
    onCloseTab: () => activeId && ws.closeSession(activeId),
  });
  useLaunchUpdateCheck();
  usePricingRefresh();

  // The context bar reflects the active tab when it's an agent, else the first
  // agent — so multiple resumed threads each drive it when focused.
  const firstAgent = projectSessions.find((s) => s.kind === "agent");
  const activeSession = projectSessions.find((s) => s.id === activeId);
  const agent = activeSession?.kind === "agent" ? activeSession : firstAgent;
  // The chat session slash commands run in — the active tab when it's a chat.
  const activeChatId = activeSession?.kind === "chat" ? activeSession.id : null;
  const chatSend = useAgentStore((s) =>
    activeChatId ? s.senders[activeChatId] : undefined
  );
  // Conflict resolution hands its prompt to the active chat session, the same
  // path the slash panel uses.
  const askClaude = chatSend
    ? (prompt: string) => {
        chatSend(prompt);
        setConflictOpen(false);
      }
    : undefined;
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
          expandAll={settings.expandAllProjects}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onSelectProject={ws.setActiveProjectId}
          onCloseProject={ws.closeProjectById}
          onPickProject={ws.pickProject}
          onSelectSession={ws.activateSession}
          onCloseSession={ws.closeSession}
          onMoveSession={ws.moveSession}
          onNewAgent={ws.newAgent}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          notificationCount={unread}
          onOpenNotifications={toggleNotifications}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ContextBar
          activeProject={activeProject}
          agent={agent}
          claudeAgent={isClaudeAgent(settings.agentCommand)}
          devRunning={projectSessions.some((s) => s.kind === "dev")}
          mrsOpen={mrsOpen}
          onToggleMrs={toggleMrs}
          devOpen={devOpen}
          devCount={devCount}
          onToggleDev={toggleDev}
          onOpenProjectSettings={openProjectSettings}
          actions={projectActions.actions}
          onRunAction={runAction}
          onEditAction={(a) => setActionEdit({ action: a })}
          onAddAction={() => setActionEdit({ action: null })}
          onStopDev={() => {
            if (activeProjectId) ws.stopAllDev(activeProjectId);
          }}
          onRefreshThreads={() => {
            if (activeProject) ws.refreshThreads(activeProject.id, activeProject.path);
          }}
          onResumeThread={ws.resumeThread}
          surfaceOpen={surfaceOpen}
          onToggleSurface={toggleSurface}
          onOpenUsage={() => setUsageOpen(true)}
        />

        <AccountBanner onLogin={activeProject ? startLogin : undefined} />

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
              onModelChange={(model) => updateSettings({ model })}
              onTitled={(session, title) => {
                ws.renameSession(session.id, title);
                ws.refreshThreads(session.projectId, session.cwd, true);
              }}
            />
            {/* The editor is an overlay, not a tab: it covers the active pane
                while open and keeps its buffers when hidden. */}
            {activeProject && editorMounted && (
              <div
                className={cn(
                  "absolute inset-1 overflow-hidden rounded-md border bg-background",
                  editorOpen ? "" : "hidden"
                )}
              >
                <Suspense fallback={null}>
                  <EditorPane
                    key={activeProject.path}
                    projectPath={activeProject.path}
                    fontFamily={settings.editorFontFamily}
                    fontSize={settings.editorFontSize}
                    active={editorOpen}
                  />
                </Suspense>
              </div>
            )}
            {activeProject && conflictOpen && (
              <div className="absolute inset-1 overflow-hidden rounded-md border bg-background">
                <Suspense fallback={null}>
                  <ConflictView
                    key={activeProject.path}
                    path={activeProject.path}
                    onDone={() => setConflictOpen(false)}
                    onAskClaude={askClaude}
                  />
                </Suspense>
              </div>
            )}
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
            onExit={ws.closeSession}
            onClose={() => setDevOpen(false)}
          />
          {/* Always mounted once opened: its terminals own live shells. */}
          {activeProject && surfaceMounted && (
            <Suspense fallback={null}>
              <SurfacePanel
                projectPath={activeProject.path}
                open={surfaceOpen}
                fontFamily={settings.fontFamily}
                fontSize={settings.fontSize}
                scrollback={settings.scrollback}
                onClose={() => setSurfaceOpen(false)}
                sessionIds={projectSessionIds}
                openRouterApiKey={settings.openRouterApiKey}
                openRouterModel={settings.openRouterModel}
                onOpenWorktree={openWorktreeAndRun}
                onRemoveWorktree={ws.removeWorktree}
              />
            </Suspense>
          )}
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
                onOpenWorktree={openWorktreeAndRun}
                onRemoveWorktree={ws.removeWorktree}
              />
            </div>
          )}
          {activeProject && mrsOpen && (
            <MergeRequestsPanel
              open={mrsOpen}
              path={activeProject.path}
              onClose={() => setMrsOpen(false)}
              onConflicts={() => setConflictOpen(true)}
            />
          )}
          {activeProject && projectSettingsOpen && (
            <SidePanel
              storageKey="projectSettings"
              onClose={() => setProjectSettingsOpen(false)}
              header={
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <SlidersHorizontal className="size-4 shrink-0" />
                  <span className="truncate">{projectLabel(activeProject)}</span>
                </div>
              }
            >
              <ProjectSettingsPane
                key={activeProject.id}
                project={activeProject}
                devCommand={dev.customCommand}
                onSetDevCommand={dev.setCustomCommand}
                buildCommand={dev.buildCommandOverride}
                onSetBuildCommand={dev.setBuildCommand}
                detectedBuildCommand={dev.detectedBuildCommand}
                startCommand={dev.startCommandOverride}
                onSetStartCommand={dev.setStartCommand}
                detectedStartCommand={dev.detectedStartCommand}
                onRefreshDokploy={() =>
                  dokploy.refresh(activeProject.id, activeProject.path)
                }
                onOpenWorktree={openWorktreeAndRun}
                onRemoveWorktree={ws.removeWorktree}
                dokployConfigured={Boolean(
                  settings.dokployUrl && settings.dokployApiKey
                )}
              />
            </SidePanel>
          )}
          {notificationsOpen && (
            <NotificationPanel
              onClose={() => setNotificationsOpen(false)}
              onSelect={jumpToSession}
            />
          )}
          {slashOpen && (
            <SlashCommandsPanel
              onClose={() => setSlashOpen(false)}
              cwd={activeProject?.path ?? null}
              activeChatId={activeChatId}
            />
          )}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={sessions}
        projects={projects}
        activeProject={activeProject}
        claudeAgent={isClaudeAgent(settings.agentCommand)}
        chatUi={settings.agentUi === "chat"}
        onSelectSession={ws.activateSession}
        onResumeThread={ws.resumeThreadIn}
        onNewAgent={ws.newAgent}
        onPickProject={ws.pickProject}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenEditor={openEditor}
        onToggleChanges={toggleChanges}
        onSearch={openSearch}
        onOpenUsage={() => setUsageOpen(true)}
        onOpenNotifications={toggleNotifications}
        onOpenSlash={() => setSlashOpen(true)}
        onRedeployDokploy={dokploy.redeploy}
        onViewDokployLogs={(service) => {
          if (activeProject) dokploy.viewLogs(activeProject, service);
        }}
      />

      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onUpdate={updateSettings}
      />

      <ActionDialog
        open={actionEdit !== null}
        onOpenChange={(o) => !o && setActionEdit(null)}
        action={actionEdit?.action ?? null}
        onSave={projectActions.upsertAction}
        onDelete={projectActions.removeAction}
      />

      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </div>
  );
}

export default App;
