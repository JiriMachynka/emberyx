import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenFileRequest } from "@/lib/openFileRequest";
import { SessionPanes } from "@/components/SessionPanes";
import { RightDock } from "@/components/RightDock";
import { ProjectSettingsPane } from "@/components/ProjectSettingsPane";
import { ChangesPanel } from "@/components/ChangesPanel";
import { NotificationPanel } from "@/components/NotificationPanel";
import { DevPanel } from "@/components/DevPanel";
import { TerminalPane } from "@/components/TerminalPane";
import { ContextBar } from "@/components/ContextBar";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { CloneDialog } from "@/components/CloneDialog";
import { PublishDialog } from "@/components/PublishDialog";
import { SlashCommandsPanel } from "@/components/SlashCommandsPanel";
import { WelcomeScreen } from "@/components/WelcomeScreen";
import { AttentionBanner } from "@/components/AttentionBanner";
import { AccountBanner } from "@/components/AccountBanner";
import { cn } from "@/lib/utils";
import {
  accessLevelToSettings,
  useSettings,
  type AccessLevel,
} from "@/lib/settings";
import {
  DOCK_KINDS,
  EMPTY_DOCK,
  closeTab,
  closeTabs,
  hideDock,
  openTab,
  showDock,
  toggleTab,
  type DockKind,
  type DockState,
} from "@/lib/dock";
import { useAgentStore, selectUnreadCount } from "@/lib/agentStore";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { requestSearch } from "@/lib/searchRequest";
import { useWorkspace } from "@/hooks/useWorkspace";
import type { Session } from "@/types";
import { FORGE_NOUN, isRemoteHost, type RemoteHost } from "@/lib/forge";
import type { CloneSource } from "@/lib/clone";
import { PreviewPanel } from "@/components/PreviewPanel";
import { useGitRemoteHost } from "@/lib/queries";
import { useDevServers } from "@/hooks/useDevServers";
import { useAgentBackend } from "@/hooks/useAgentBackend";
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

// Full-screen surfaces and a dock tab most sessions never open. Each already
// renders behind its own flag, so lazy loading changes nothing but when the
// code arrives — and together they are ~250 KB off the startup parse.
const SettingsPage = lazy(() =>
  import("@/components/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const UsagePanel = lazy(() =>
  import("@/components/UsagePanel").then((m) => ({ default: m.UsagePanel }))
);
const MergeRequestsPanel = lazy(() =>
  import("@/components/MergeRequestsPanel").then((m) => ({
    default: m.MergeRequestsPanel,
  }))
);

/** Fetch and parse the settings chunk while the app is idle. Lazy keeps it out
 *  of the startup parse; warming it keeps the first open from showing the
 *  Suspense blank instead of a page. */
const warmSettingsChunk = () => {
  void import("@/components/SettingsPage");
};

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<CloneSource | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // Every right-hand surface is a tab of one dock, so a diff and a terminal are
  // a click apart instead of mutually exclusive asides.
  const [dock, setDock] = useState<DockState>(EMPTY_DOCK);
  const [usageOpen, setUsageOpen] = useState(false);
  // Settings and usage cover the workspace column rather than replacing it.
  const overlayOpen = settingsOpen || usageOpen;
  const [slashOpen, setSlashOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Once opened the editor stays mounted and is merely hidden, so open buffers,
  // scroll position and undo history survive closing it.
  const [editorMounted, setEditorMounted] = useState(false);
  const [sidebarCollapsed, setCollapsed] = useState<boolean>(getSidebarCollapsed);

  const dockActive = dock.active;
  const showTab = (kind: DockKind) => setDock((s) => openTab(s, kind));
  const hideTab = (kind: DockKind) => setDock((s) => closeTab(s, kind));
  const flipTab = (kind: DockKind) => setDock((s) => toggleTab(s, kind));
  // The dock's own toggle reveals the chooser when nothing is open, and
  // otherwise hides the panel without dropping the tabs that were showing.
  const toggleDock = () =>
    setDock((s) => (s.open ? hideDock(s) : showDock(s)));

  // Clicking a file in the chat brings the Files tab forward; the editor pane
  // itself picks the file up from the same request.
  useEffect(() => onOpenFileRequest(() => showTab("files")), []);

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
  } = ws;

  // ChatPanes are memoized, so their callbacks must keep a stable identity
  // across a session switch or the memo can't short-circuit. updateSettings and
  // the ws.* helpers are recreated every render, so route through refs.
  const modelChangeRef = useRef(updateSettings);
  modelChangeRef.current = updateSettings;
  const onModelChange = useCallback(
    (model: string) => modelChangeRef.current({ model }),
    []
  );
  const onEffortChange = useCallback(
    (effort: string) => modelChangeRef.current({ effort }),
    []
  );
  // The composer shows one access level; the stored pair is what a spawn needs.
  const onAccessChange = useCallback(
    (level: AccessLevel) => modelChangeRef.current(accessLevelToSettings(level)),
    []
  );
  const titledRef = useRef<(session: Session, title: string) => void>(() => {});
  titledRef.current = (session, title) => {
    ws.renameSession(session.id, title);
    ws.refreshThreads(session.projectId, session.cwd, true);
  };
  const onTitled = useCallback(
    (session: Session, title: string) => titledRef.current(session, title),
    []
  );
  const threadStartedRef = useRef<
    (session: Session, threadId: string, firstMessage: string) => void
  >(() => {});
  threadStartedRef.current = (session, threadId, firstMessage) => {
    ws.registerThread(session.id, session.projectId, threadId, firstMessage);
  };
  const onThreadStarted = useCallback(
    (session: Session, threadId: string, firstMessage: string) =>
      threadStartedRef.current(session, threadId, firstMessage),
    []
  );

  // Project-scoped panels close when switching projects, so a panel opened
  // for one project doesn't linger empty over the next. Output stays — it
  // already retargets to the new project's servers.
  useEffect(() => {
    const idle = window.requestIdleCallback?.(warmSettingsChunk);
    if (idle === undefined) warmSettingsChunk();
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
    };
  }, []);

  useEffect(() => {
    setDock((s) => closeTabs(s, DOCK_KINDS.filter((k) => k !== "dev")));
  }, [activeProjectId]);

  // Which service the active project's remote is on. The review panel speaks
  // one shape for both; only the endpoints and the wording differ.
  const remoteHostValue = useGitRemoteHost(activeProject?.path ?? "").data;
  const remoteHost: RemoteHost =
    remoteHostValue && isRemoteHost(remoteHostValue) ? remoteHostValue : "gitlab";
  const agentBackend = useAgentBackend(activeProject, settings.agentBackend);
  const capabilities = agentBackend.capabilities;
  const dev = useDevServers(activeProject, ws.addDev);
  const projectActions = useProjectActions(activeProject);
  const [actionEdit, setActionEdit] = useState<{
    action: ProjectAction | null;
  } | null>(null);
  // Run an action's command as an output session; reveal the panel on the setting.
  const runAction = (a: ProjectAction) => {
    if (!activeProject) return;
    ws.addDev(activeProject.id, a.name, activeProject.path, a.command);
    if (settings.autoOpenDevPanel) showTab("dev");
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

  // Signing in is interactive (browser hand-off, then a code pasted back) —
  // that needs a real terminal, and the app no longer hosts one, so the flow
  // runs in the system terminal. The binary comes from the configured agent
  // command so a wrapper or absolute path still resolves.
  const startLogin = () => {
    const bin =
      agentBackend.backend === "claude"
        ? settings.agentCommand.split(" ")[0]
        : "claude";
    void invoke("open_in_terminal", { command: `${bin} auth login` }).catch(
      (e) => toast.error("Couldn't open Terminal", { description: String(e) })
    );
  };

  const openProjectSettings = () => {
    if (!activeProject) return;
    showTab("projectSettings");
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
    onSelectTab: (index) => {
      const tabs = projectSessions.filter((s) => s.kind !== "dev");
      const target = tabs[index];
      if (target) ws.activateSession(target.projectId, target.id);
    },
    onCycleTab: (direction) => {
      const tabs = projectSessions.filter((s) => s.kind !== "dev");
      const current = tabs.findIndex((s) => s.id === activeId);
      if (tabs.length === 0) return;
      const next = (current + direction + tabs.length) % tabs.length;
      const target = tabs[next];
      if (target) ws.activateSession(target.projectId, target.id);
    },
  });
  useLaunchUpdateCheck();
  usePricingRefresh();

  // The context bar follows the focused chat tab, else the project's first one.
  const firstAgent = projectSessions.find((s) => s.kind === "chat");
  const activeSession = projectSessions.find((s) => s.id === activeId);
  const agent = activeSession?.kind === "chat" ? activeSession : firstAgent;
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

  // Content per dock tab. The dock decides what is mounted — a pane that owns a
  // child process stays mounted once opened, the rest come and go with the tab.
  const dockPanes: Partial<Record<DockKind, React.ReactNode>> = {
    terminal: activeProject && (
      <TerminalPane
        cwd={activeProject.path}
        fontFamily={settings.fontFamily}
        fontSize={settings.fontSize}
        scrollback={settings.scrollback}
        active={dockActive === "terminal"}
      />
    ),
    files: activeProject && (
      <Suspense fallback={null}>
        <EditorPane
          key={activeProject.path}
          projectPath={activeProject.path}
          fontFamily={settings.editorFontFamily}
          fontSize={settings.editorFontSize}
          wordWrap={settings.wordWrap}
          active={dockActive === "files"}
        />
      </Suspense>
    ),
    diff: activeProject && (
      <ChangesPanel
        embedded
        active={dockActive === "diff"}
        projectPath={activeProject.path}
        sessionIds={projectSessionIds}
        ignoreWhitespace={settings.diffIgnoreWhitespace}
        onClose={() => hideTab("diff")}
        onOpenWorktree={openWorktreeAndRun}
        onRemoveWorktree={ws.removeWorktree}
      />
    ),
    preview: activeProject && (
      <PreviewPanel
        embedded
        open={dockActive === "preview"}
        projectPath={activeProject.path}
        onClose={() => hideTab("preview")}
      />
    ),
    mrs: activeProject && (
      <Suspense fallback={null}>
        <MergeRequestsPanel
          embedded
          open={dockActive === "mrs"}
          host={remoteHost}
          path={activeProject.path}
          onClose={() => hideTab("mrs")}
          onConflicts={() => setConflictOpen(true)}
        />
      </Suspense>
    ),
    dev: (
      <DevPanel
        embedded
        sessions={devSessions}
        projectId={activeProject?.id ?? null}
        open={dockActive === "dev"}
        fontFamily={settings.fontFamily}
        fontSize={settings.fontSize}
        onStop={ws.closeSession}
        onClose={() => hideTab("dev")}
      />
    ),
    projectSettings: activeProject && (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ProjectSettingsPane
          key={activeProject.id}
          project={activeProject}
          backend={agentBackend.pinned}
          onSetBackend={agentBackend.setBackend}
          defaultBackend={settings.agentBackend}
          devCommand={dev.customCommand}
          onSetDevCommand={dev.setCustomCommand}
          buildCommand={dev.buildCommandOverride}
          onSetBuildCommand={dev.setBuildCommand}
          detectedBuildCommand={dev.detectedBuildCommand}
          startCommand={dev.startCommandOverride}
          onSetStartCommand={dev.setStartCommand}
          detectedStartCommand={dev.detectedStartCommand}
          onOpenWorktree={openWorktreeAndRun}
          onRemoveWorktree={ws.removeWorktree}
        />
      </div>
    ),
  };

  return (
    <div className="flex h-full bg-background text-foreground">
      {revealed && projects.length > 0 && (
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeByProject={ws.activeByProject}
          sessionsFor={ws.sessionsFor}
          expandAll={settings.expandAllProjects}
          threadView={settings.threadView}
          threadSettleDays={settings.threadSettleDays}
          threadAutoSettleOnMerge={settings.threadAutoSettleOnMerge}
          threadGrouping={settings.threadGrouping}
          fontFamily={settings.chatFontFamily}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onSelectProject={(id) => {
            setSettingsOpen(false);
            setUsageOpen(false);
            ws.setActiveProjectId(id);
          }}
          onCloseProject={ws.closeProjectById}
          onPickProject={ws.pickProject}
          onSelectSession={(projectId, id) => {
            setSettingsOpen(false);
            setUsageOpen(false);
            ws.activateSession(projectId, id);
          }}
          onResumeThread={(projectId, path, thread) => {
            setSettingsOpen(false);
            setUsageOpen(false);
            ws.resumeThreadIn(projectId, path, thread);
          }}
          onCloseSession={ws.closeSession}
          onMoveSession={ws.moveSession}
          onNewAgent={() => {
            setSettingsOpen(false);
            setUsageOpen(false);
            ws.newAgent();
          }}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenSettings={() => {
            setUsageOpen(false);
            setSettingsOpen(true);
          }}
           settingsOpen={settingsOpen}
           onBackFromSettings={() => setSettingsOpen(false)}
          onOpenUsage={() => {
            setSettingsOpen(false);
            setUsageOpen(true);
          }}
          notificationCount={unread}
          onOpenNotifications={toggleNotifications}
        />
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {!overlayOpen && (
          <>
            <ContextBar
              activeProject={activeProject}
              agent={agent}
              devRunning={projectSessions.some((s) => s.kind === "dev")}
              mrsOpen={dockActive === "mrs"}
              onToggleMrs={() => flipTab("mrs")}
              previewOpen={dockActive === "preview"}
              onTogglePreview={() => flipTab("preview")}
              devOpen={dockActive === "dev"}
              devCount={devCount}
              onToggleDev={() => flipTab("dev")}
              onOpenProjectSettings={openProjectSettings}
              actions={projectActions.actions}
              onRunAction={runAction}
              onEditAction={(a) => setActionEdit({ action: a })}
              onAddAction={() => setActionEdit({ action: null })}
              onStopDev={() => {
                if (activeProjectId) ws.stopAllDev(activeProjectId);
              }}
              dockOpen={dock.open}
              onToggleDock={toggleDock}
            />

            <AccountBanner onLogin={activeProject ? startLogin : undefined} />

            {agent && activeProjectId && (
              <AttentionBanner
                agentId={agent.id}
                onJump={() => ws.setActive(activeProjectId, agent.id)}
              />
            )}
          </>
        )}

        {/* Covered by the overlay, never unmounted and never `display:none`.
            Display-none makes every element a ResizeObserver watches report a
            height of 0 — including every chat row TanStack Virtual measures —
            so the transcript's measurement cache collapsed on the way in and
            was rebuilt in one frame on the way out. That was the stall on the
            back button. `invisible` keeps the layout boxes, so nothing
            re-measures, and skips the painting of a surface nobody can see. */}
        <div
          className={cn("flex min-h-0 flex-1", overlayOpen && "invisible")}
          inert={overlayOpen}
        >
           <main className="canvas-lit relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {/* Panes stay mounted once a session exists, so a pre-warmed
                project boots in the background. Hidden unless it's the active,
                revealed tab. */}
            <SessionPanes
              sessions={sessions}
              activeId={activeId}
              settings={settings}
              onModelChange={onModelChange}
             onEffortChange={onEffortChange}
             onAccessChange={onAccessChange}
             projects={projects}
             recentProjects={recents}
             onSelectProject={ws.setActiveProjectId}
             onOpenProject={ws.openProjectAt}
             onTitled={onTitled}
             onThreadStarted={onThreadStarted}
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
                    wordWrap={settings.wordWrap}
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
          <RightDock
            state={dock}
            available={activeProject ? DOCK_KINDS : []}
            panes={dockPanes}
            onSelect={showTab}
            onClose={hideTab}
            onAdd={showTab}
            onHide={() => setDock(hideDock)}
            titles={{
              preview: "Browser",
              mrs: remoteHost === "github" ? "Pull request" : "Merge request",
            }}
            unavailable={
              remoteHostValue && isRemoteHost(remoteHostValue)
                ? undefined
                : { mrs: `No ${FORGE_NOUN[remoteHost].one} on this branch yet.` }
            }
          />
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
              backend={agentBackend.backend}
            />
          )}
        </div>

        {overlayOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-background">
            <Suspense fallback={null}>
              {settingsOpen ? (
                <SettingsPage
                  onBack={() => setSettingsOpen(false)}
                  settings={settings}
                  onUpdate={updateSettings}
                />
              ) : (
                <UsagePanel onBack={() => setUsageOpen(false)} />
              )}
            </Suspense>
          </div>
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={sessions}
        projects={projects}
        activeProject={activeProject}
        slashCommands={capabilities.slashCommands}
        onSelectSession={(projectId, id) => {
          setSettingsOpen(false);
          setUsageOpen(false);
          ws.activateSession(projectId, id);
        }}
        onResumeThread={(projectId, path, thread) => {
          setSettingsOpen(false);
          setUsageOpen(false);
          ws.resumeThreadIn(projectId, path, thread);
        }}
        onNewAgent={() => {
          setSettingsOpen(false);
          setUsageOpen(false);
          ws.newAgent();
        }}
        onPickProject={ws.pickProject}
        onCloneGithub={() => setCloneSource("github")}
        onCloneGitlab={() => setCloneSource("gitlab")}
        onCloneUrl={() => setCloneSource("url")}
        onPublish={() => setPublishOpen(true)}
        onOpenSettings={() => {
          setUsageOpen(false);
          setSettingsOpen(true);
        }}
        onOpenEditor={openEditor}
        onToggleChanges={() => flipTab("diff")}
        onSearch={openSearch}
        onOpenUsage={() => {
          setSettingsOpen(false);
          setUsageOpen(true);
        }}
        onOpenNotifications={toggleNotifications}
        onOpenSlash={() => setSlashOpen(true)}
      />

      <CloneDialog
        open={cloneSource !== null}
        source={cloneSource}
        onOpenChange={(o) => {
          if (!o) setCloneSource(null);
        }}
        onCloned={(path) => void ws.openProjectAt(path)}
      />
      <PublishDialog
        open={publishOpen}
        projectPath={activeProject?.path ?? null}
        onOpenChange={setPublishOpen}
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
