import { useState } from "react";
import { Plus, PanelLeftClose, PanelLeftOpen, Settings, Bot, FolderOpen, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { projectLabel, projectTitle } from "@/lib/worktree";
import { statusOf } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { TabCloseButton } from "@/components/TabCloseButton";
import { useAgentStore } from "@/lib/agentStore";
import type { Project, Session, SessionStatus } from "@/types";

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeByProject: Record<string, string>;
  statuses: Record<string, SessionStatus>;
  sessionsFor: (id: string) => Session[];
  /** Keep every project's session list open, not only the active project's. */
  expandAll: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void;
  onPickProject: () => void;
  onSelectSession: (projectId: string, id: string) => void;
  onCloseSession: (id: string) => void;
  onMoveSession: (projectId: string, from: string, to: string) => void;
  onNewAgent: () => void;
  onOpenSettings: () => void;
}

/** Left navigation: projects as rows, the active one expanded to its sessions
 *  plus a project-scoped action row. Collapses to an icon rail (status dots
 *  survive) via the header toggle / ⌘B. */
export function Sidebar(props: Omit<SidebarProps, "statuses">) {
  const { collapsed } = props;
  // Live status comes from the store so status-dot updates re-render the
  // sidebar (which must reflect them) without re-rendering App.
  const statuses = useAgentStore((s) => s.statuses);
  const full: SidebarProps = { ...props, statuses };
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-64"
      )}
    >
      <SidebarHeader {...full} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
        {collapsed ? <Rail {...full} /> : <Tree {...full} />}
      </div>
      <SidebarFooter {...full} />
    </aside>
  );
}

function SidebarHeader({ collapsed, onToggleCollapse }: SidebarProps) {
  return (
    <header
      className={cn(
        "flex h-11 shrink-0 items-center border-b",
        collapsed ? "justify-center" : "justify-between px-2.5"
      )}
    >
      {!collapsed && (
        <div className="flex items-center gap-2">
          <img src="/emberyx.png" alt="" className="size-5 rounded-[5px] shadow" />
          <span className="ember-text text-sm font-semibold tracking-tight">
            Emberyx
          </span>
        </div>
      )}
      <button
        onClick={onToggleCollapse}
        className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </button>
    </header>
  );
}

/** Expanded project → session tree. */
function Tree(props: SidebarProps) {
  const {
    projects,
    activeProjectId,
    activeByProject,
    statuses,
    sessionsFor,
    expandAll,
    onSelectProject,
    onCloseProject,
    onPickProject,
  } = props;

  return (
    <div className="px-1.5">
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
        const pAgent = pSessions.find((s) => s.kind === "agent");
        const anyWorking = pSessions.some(
          (s) => s.kind === "agent" && statusOf(statuses, s.id) === "working"
        );
        return (
          <div key={p.id} className="mb-0.5">
            <div
              onClick={() => onSelectProject(p.id)}
              className={cn(
                "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
                active
                  ? "surface-raised bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
              title={projectTitle(p)}
            >
              <div className="relative shrink-0">
                {p.icon ? (
                  <img src={p.icon} alt="" className="size-7 rounded-md" />
                ) : (
                  <div className="flex size-7 items-center justify-center rounded-md bg-secondary text-xs font-semibold uppercase text-muted-foreground">
                    {basename(p.worktree?.repoRoot ?? p.path).charAt(0)}
                  </div>
                )}
                <StatusDot
                  status={
                    anyWorking
                      ? "working"
                      : pAgent
                        ? statusOf(statuses, pAgent.id)
                        : "idle"
                  }
                  className="absolute -bottom-0.5 -right-0.5 ring-2 ring-background"
                />
              </div>
              <span className="flex-1 truncate font-medium">
                {projectLabel(p)}
              </span>
              {active && p.workspace && (
                <span className="rounded bg-background/60 px-1 py-px text-xs text-muted-foreground">
                  {p.workspace.kind}
                </span>
              )}
              {p.worktree && (
                <span className="flex min-w-0 max-w-20 shrink items-center gap-1 rounded bg-background/60 px-1 py-px text-xs text-muted-foreground">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{p.worktree.branch}</span>
                </span>
              )}
              <TabCloseButton
                active={active}
                title="Close project"
                onClose={() => onCloseProject(p.id)}
              />
            </div>

            {(active || expandAll) && (
              <SessionList
                {...props}
                // Dev servers live in the Dev panel, not as sidebar tabs.
                sessions={pSessions.filter((s) => s.kind !== "dev")}
                activeId={activeByProject[p.id] ?? null}
                projectId={p.id}
              />
            )}
            {active && <ActionRow {...props} project={p} />}
          </div>
        );
      })}

      <button
        onClick={onPickProject}
        className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        title="Open project (⌘O)"
      >
        <Plus className="size-4" />
        Open project
      </button>
    </div>
  );
}

/** The active project's sessions, indented and drag-reorderable. */
function SessionList({
  sessions,
  activeId,
  projectId,
  statuses,
  onSelectSession,
  onCloseSession,
  onMoveSession,
}: SidebarProps & {
  sessions: Session[];
  activeId: string | null;
  projectId: string;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <ul className="ml-3 mt-0.5 border-l pl-1.5">
      {sessions.map((s) => {
        const st = statusOf(statuses, s.id);
        const active = s.id === activeId;
        return (
          <li
            key={s.id}
            draggable
            onClick={() => onSelectSession(projectId, s.id)}
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragId && dragId !== s.id) setOverId(s.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) onMoveSession(projectId, dragId, s.id);
              setDragId(null);
              setOverId(null);
            }}
            className={cn(
              "group flex cursor-grab items-center gap-2 rounded px-2 py-1.5 text-sm active:cursor-grabbing",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-secondary/50",
              dragId === s.id && "opacity-40",
              overId === s.id && "ring-1 ring-primary/60"
            )}
          >
            {s.kind === "agent" ? (
              <Bot className="size-4 shrink-0 opacity-70" />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            )}
            <span className="flex-1 truncate">
              {s.kind === "dev" ? `dev:${s.label}` : s.label}
            </span>
            {s.kind === "agent" && st !== "idle" && <StatusDot status={st} />}
            <TabCloseButton
              active={active}
              title={s.kind === "dev" ? "Stop" : "Close"}
              onClose={() => onCloseSession(s.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** Project-scoped actions for the active project. */
function ActionRow({
  onNewAgent,
}: SidebarProps & { project: Project }) {
  return (
    <div className="ml-3 mt-1 flex flex-wrap items-center gap-1 pl-1.5">
      <button
        onClick={onNewAgent}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="New agent tab (⌘T)"
      >
        <Plus className="size-4" />
        Agent
      </button>
    </div>
  );
}

/** Icon rail: one avatar per project, status dot preserved. */
function Rail({
  projects,
  activeProjectId,
  statuses,
  sessionsFor,
  onSelectProject,
  onPickProject,
}: SidebarProps) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
        const pAgent = pSessions.find((s) => s.kind === "agent");
        const anyWorking = pSessions.some(
          (s) => s.kind === "agent" && statusOf(statuses, s.id) === "working"
        );
        const st = anyWorking
          ? "working"
          : pAgent
            ? statusOf(statuses, pAgent.id)
            : "idle";
        return (
          <button
            key={p.id}
            onClick={() => onSelectProject(p.id)}
            title={projectTitle(p)}
            className={cn(
              "relative flex size-10 items-center justify-center rounded-lg text-sm font-semibold uppercase transition-colors",
              active
                ? "surface-raised bg-secondary text-foreground ember-glow"
                : "bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            )}
          >
            {p.icon ? (
              <img
                src={p.icon}
                alt=""
                className="size-8 rounded object-contain"
              />
            ) : (
              basename(p.worktree?.repoRoot ?? p.path).slice(0, 2)
            )}
            {st !== "idle" && (
              <StatusDot
                status={st}
                className="absolute -right-0.5 -top-0.5 ring-2 ring-sidebar"
              />
            )}
          </button>
        );
      })}
      <button
        onClick={onPickProject}
        title="Open project (⌘O)"
        className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
      >
        <FolderOpen className="size-5" />
      </button>
    </div>
  );
}

function SidebarFooter({ collapsed, onOpenSettings }: SidebarProps) {
  return (
    <footer
      className={cn(
        "flex h-10 shrink-0 items-center border-t",
        collapsed ? "justify-center" : "px-2.5"
      )}
    >
      <button
        onClick={onOpenSettings}
        className="flex items-center gap-2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Settings"
      >
        <Settings className="size-5" />
        {!collapsed && <span className="text-sm">Settings</span>}
      </button>
    </footer>
  );
}
