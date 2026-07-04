import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  FolderOpen,
  Settings,
  Bot,
  X,
  FileDiff,
  Clock,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalPane } from "@/components/TerminalPane";
import { DevMenu } from "@/components/DevMenu";
import { ThreadMenu } from "@/components/ThreadMenu";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { STATUS_META } from "@/lib/status";
import { useSettings } from "@/lib/settings";
import { getRecents, addRecent } from "@/lib/recents";
import { costOf, totalTokens, formatTokens } from "@/lib/pricing";
import { useSessions } from "@/hooks/useSessions";
import { useProjects } from "@/hooks/useProjects";
import { useAgentEvents } from "@/hooks/useAgentEvents";
import type { PackageInfo, SessionStatus, Thread, WorkspaceInfo } from "@/types";

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
    closeProject,
  } = useProjects();

  const {
    sessions,
    activeByProject,
    setActive,
    startAgent,
    addDev,
    closeSession,
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
  const projectSessions = activeProjectId ? sessionsFor(activeProjectId) : [];
  const activeId = activeProjectId
    ? activeByProject[activeProjectId] ?? null
    : null;

  /** Build the agent launch command, injecting hooks + any extra flags. */
  function buildAgentCommand(extra?: string): string {
    const base = settings.agentCommand;
    const flags: string[] = [];
    if (base.startsWith("claude")) {
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
      .catch((e) => console.error("list_threads failed:", e));
  }

  function openProjectAt(path: string) {
    const { id, isNew } = openProject(path);
    setRecents(addRecent(path));
    if (isNew) {
      startAgent(id, path, buildAgentCommand());
      invoke<WorkspaceInfo>("scan_workspace", { path })
        .then((w) => setWorkspace(id, w))
        .catch((e) => console.error("scan_workspace failed:", e));
    }
    refreshThreads(id, path);
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

  function handleCloseProject(id: string) {
    const ids = sessionsFor(id).map((s) => s.id);
    closeProjectSessions(id);
    clearSessions(ids);
    closeProject(id);
  }

  // ⌘O opens the folder picker.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        void pickProject();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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

  const showTabs = projectSessions.length > 1;
  // Header reflects the active tab when it's an agent, else the first agent —
  // so multiple resumed threads each drive the header when focused.
  const firstAgent = projectSessions.find((s) => s.kind === "agent");
  const activeSession = projectSessions.find((s) => s.id === activeId);
  const agent =
    activeSession?.kind === "agent" ? activeSession : firstAgent;
  const agentStatus: SessionStatus = agent
    ? statuses[agent.id] ?? "idle"
    : "idle";
  const agentUsage = agent ? usages[agent.id] : undefined;
  const projectChanges = changes.filter((c) =>
    projectSessions.some((s) => s.id === c.session)
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2">
          <img src="/emberyx.png" alt="Emberyx" className="size-5 rounded-[5px]" />
          <span className="text-sm font-semibold tracking-tight">Emberyx</span>
          {activeProject && activeProject.workspace && (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
              {activeProject.workspace.kind}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {agentUsage && agentUsage.messages > 0 && (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground"
              title={`${agentUsage.input.toLocaleString()} in · ${agentUsage.output.toLocaleString()} out · ${agentUsage.cacheRead.toLocaleString()} cache read · ${agentUsage.cacheCreation.toLocaleString()} cache write${
                agentUsage.model ? ` · ${agentUsage.model}` : ""
              }`}
            >
              {formatTokens(totalTokens(agentUsage))} tok
              <span className="opacity-40">·</span>${costOf(agentUsage).toFixed(2)}
            </span>
          )}
          {agent && (
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                STATUS_META[agentStatus].text
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  STATUS_META[agentStatus].dot,
                  STATUS_META[agentStatus].pulse && "animate-pulse"
                )}
              />
              {STATUS_META[agentStatus].label}
            </span>
          )}
          {activeProject && settings.agentCommand.startsWith("claude") && (
            <ThreadMenu
              threads={activeProject.threads}
              onOpen={() => refreshThreads(activeProject.id, activeProject.path)}
              onResume={resumeThread}
            />
          )}
          {activeProject && (
            <DevMenu
              workspace={activeProject.workspace}
              running={projectSessions.some((s) => s.kind === "dev")}
              onRunPackage={runPackage}
              onRunAll={runAll}
              onStop={() => activeProjectId && stopAllDev(activeProjectId)}
            />
          )}
          {activeProject && (
            <Button
              variant={changesOpen ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setChangesOpen((v) => !v)}
              title="Agent changes"
            >
              <FileDiff className="size-3.5" />
              {projectChanges.length > 0 && projectChanges.length}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </header>

      {/* Project tab strip */}
      {projects.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
          {projects.map((p) => {
            const pAgent = sessionsFor(p.id).find((s) => s.kind === "agent");
            const st: SessionStatus = pAgent
              ? statuses[pAgent.id] ?? "idle"
              : "idle";
            return (
              <div
                key={p.id}
                onClick={() => setActiveProjectId(p.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs",
                  p.id === activeProjectId
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50"
                )}
                title={p.path}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    STATUS_META[st].dot,
                    STATUS_META[st].pulse && "animate-pulse"
                  )}
                />
                <span className="max-w-[12rem] truncate">
                  {basename(p.path)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseProject(p.id);
                  }}
                  className="rounded p-0.5 hover:bg-accent"
                  title="Close project"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <button
            onClick={pickProject}
            className="rounded p-1 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            title="Open project (⌘O)"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onUpdate={updateSettings}
      />

      {/* Needs-approval banner */}
      {agent && agentStatus === "waiting" && activeProjectId && (
        <button
          onClick={() => setActive(activeProjectId, agent.id)}
          className="flex h-7 shrink-0 items-center justify-center gap-2 bg-amber-500/15 text-xs text-amber-300 hover:bg-amber-500/25"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          Claude needs your input — click to jump to the agent
        </button>
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
                  fontFamily={settings.fontFamily}
                  fontSize={settings.fontSize}
                  scrollback={settings.scrollback}
                  active={s.id === activeId}
                />
              </div>
            ))
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
              <img
                src="/emberyx.png"
                alt="Emberyx"
                className="size-16 rounded-2xl shadow-lg"
              />
              <div>
                <h1 className="text-lg font-semibold">Open a project</h1>
                <p className="text-sm text-muted-foreground">
                  Emberyx launches your agent in an integrated terminal.
                </p>
              </div>
              <Button onClick={pickProject}>
                <FolderOpen className="size-4" />
                Open project…
                <span className="ml-1 text-xs opacity-60">⌘O</span>
              </Button>
              {recents.length > 0 && (
                <div className="w-72 text-left">
                  <div className="mb-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    Recent
                  </div>
                  <ul className="rounded-md border">
                    {recents.map((p) => (
                      <li key={p}>
                        <button
                          onClick={() => openProjectAt(p)}
                          className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-sm hover:bg-accent"
                          title={p}
                        >
                          <span className="truncate">{basename(p)}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {dirname(p)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
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

      {/* Bottom tab strip (active project's agent + dev servers) */}
      {showTabs && activeProjectId && (
        <footer className="flex h-9 shrink-0 items-center gap-1 border-t px-2">
          {projectSessions.map((s) => {
            const st = statuses[s.id] ?? "idle";
            return (
              <div
                key={s.id}
                onClick={() => setActive(activeProjectId, s.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs",
                  s.id === activeId
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50"
                )}
              >
                {s.kind === "agent" ? (
                  <Bot className={cn("size-3.5", STATUS_META[st].text)} />
                ) : (
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                )}
                <span className="max-w-[10rem] truncate">
                  {s.kind === "dev" ? `dev:${s.label}` : s.label}
                </span>
                {s.kind === "agent" && st !== "idle" && (
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      STATUS_META[st].dot,
                      STATUS_META[st].pulse && "animate-pulse"
                    )}
                  />
                )}
                {s.kind === "dev" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(s.id);
                    }}
                    className="rounded p-0.5 hover:bg-accent"
                    title="Stop"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </footer>
      )}
    </div>
  );
}

export default App;
