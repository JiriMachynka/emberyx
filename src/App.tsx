import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { FolderOpen, Settings, Flame, Bot, X, FileDiff, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalPane } from "@/components/TerminalPane";
import { DevMenu } from "@/components/DevMenu";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ChangesPanel } from "@/components/ChangesPanel";
import { cn } from "@/lib/utils";
import { STATUS_META, statusForEvent } from "@/lib/status";
import { useSettings } from "@/lib/settings";
import { parseChange, type Change } from "@/lib/changes";
import { getRecents, addRecent } from "@/lib/recents";
import type {
  HookEvent,
  PackageInfo,
  Session,
  SessionStatus,
  WorkspaceInfo,
} from "@/types";

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function App() {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [hookSettings, setHookSettings] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(getRecents);
  const { settings, update: updateSettings } = useSettings();
  const counter = useRef(0);
  const nextId = () => `s${++counter.current}`;

  // Keep latest sessions readable inside the (stable) hook-event listener.
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;

  // Startup: load the hook settings path, ask for notification permission,
  // and subscribe to hook events for the lifetime of the app.
  useEffect(() => {
    invoke<string>("hook_config")
      .then(setHookSettings)
      .catch((e) => console.error("hook_config failed:", e));

    (async () => {
      if (!(await isPermissionGranted())) await requestPermission();
    })();

    const unlisten = listen<HookEvent>("hook-event", ({ payload }) => {
      const change = parseChange(payload);
      if (change) setChanges((prev) => [...prev, change]);

      const status = statusForEvent(payload.event);
      if (!status) return;
      setStatuses((prev) => ({ ...prev, [payload.session]: status }));

      if (status === "waiting" && !document.hasFocus()) {
        const s = sessionsRef.current.find((x) => x.id === payload.session);
        void isPermissionGranted().then((granted) => {
          if (granted) {
            sendNotification({
              title: "Emberyx — agent needs you",
              body: s ? basename(s.cwd) : "Claude is waiting for input",
            });
          }
        });
      }
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  function openProjectAt(path: string) {
    const agentId = nextId();
    const base = settings.agentCommand;
    const command =
      base.startsWith("claude") && hookSettings
        ? `${base} --settings "${hookSettings}"`
        : base;
    setProjectPath(path);
    setWorkspace(null);
    setStatuses({});
    setChanges([]);
    setRecents(addRecent(path));
    setSessions([
      { id: agentId, label: "agent", cwd: path, command, kind: "agent" },
    ]);
    setActiveId(agentId);

    invoke<WorkspaceInfo>("scan_workspace", { path })
      .then(setWorkspace)
      .catch((e) => console.error("scan_workspace failed:", e));
  }

  async function pickProject() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") openProjectAt(selected);
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

  function addDev(label: string, cwd: string, command: string) {
    const id = nextId();
    // Start in the background — appears as a tab but doesn't steal the view
    // from the agent. Click the tab to see its logs.
    setSessions((s) => [...s, { id, label, cwd, command, kind: "dev" }]);
  }

  function runPackage(pkg: PackageInfo) {
    addDev(pkg.name, pkg.path, pkg.devCommand);
  }

  function runAll() {
    if (!workspace || !projectPath) return;
    if (workspace.allCommand) {
      addDev("all", projectPath, workspace.allCommand);
    } else {
      workspace.packages.forEach((p) => addDev(p.name, p.path, p.devCommand));
    }
  }

  function closeSession(id: string) {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      return next;
    });
  }

  function stopAllDev() {
    setSessions((prev) => {
      const next = prev.filter((s) => s.kind !== "dev");
      setActiveId(next.find((s) => s.kind === "agent")?.id ?? null);
      return next;
    });
  }

  const showTabs = sessions.length > 1;
  const agent = sessions.find((s) => s.kind === "agent");
  const agentStatus: SessionStatus = agent
    ? statuses[agent.id] ?? "idle"
    : "idle";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2">
          <Flame className="size-4 text-primary" />
          <span className="text-sm font-semibold tracking-tight">Emberyx</span>
          {projectPath && (
            <>
              <span className="text-muted-foreground">/</span>
              <button
                onClick={pickProject}
                className="rounded px-1.5 py-0.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                title={projectPath}
              >
                {basename(projectPath)}
              </button>
              {workspace && workspace.kind !== "single" && (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                  {workspace.kind}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
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
          {projectPath && (
            <DevMenu
              workspace={workspace}
              running={sessions.some((s) => s.kind === "dev")}
              onRunPackage={runPackage}
              onRunAll={runAll}
              onStop={stopAllDev}
            />
          )}
          {projectPath && (
            <Button
              variant={changesOpen ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setChangesOpen((v) => !v)}
              title="Agent changes"
            >
              <FileDiff className="size-3.5" />
              {changes.length > 0 && changes.length}
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

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onUpdate={updateSettings}
      />

      {/* Needs-approval banner */}
      {agent && agentStatus === "waiting" && (
        <button
          onClick={() => setActiveId(agent.id)}
          className="flex h-7 shrink-0 items-center justify-center gap-2 bg-amber-500/15 text-xs text-amber-300 hover:bg-amber-500/25"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          Claude needs your input — click to jump to the agent
        </button>
      )}

      {/* Terminal viewport + changes panel */}
      <div className="flex min-h-0 flex-1">
        <main className="relative flex-1 bg-[#1a1a1e] p-1">
          {projectPath ? (
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
                />
              </div>
            ))
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
              <Flame className="size-10 text-primary/60" />
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
                            {p.replace(/\/[^/]+$/, "")}
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
        {projectPath && changesOpen && (
          <ChangesPanel
            projectPath={projectPath}
            changes={changes}
            onClose={() => setChangesOpen(false)}
          />
        )}
      </div>

      {/* Bottom tab strip (agent + dev servers) */}
      {showTabs && (
        <footer className="flex h-9 shrink-0 items-center gap-1 border-t px-2">
          {sessions.map((s) => {
            const st = statuses[s.id] ?? "idle";
            return (
              <div
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs",
                  s.id === activeId
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50"
                )}
              >
                {s.kind === "agent" ? (
                  <Bot
                    className={cn("size-3.5", STATUS_META[st].text)}
                  />
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
