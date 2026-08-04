import { memo, useState } from "react";
import { Plus, SquarePen, PanelLeftClose, PanelLeftOpen, Settings, Bot, FolderOpen, GitBranch, Bell, Search } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { projectLabel, projectTitle } from "@/lib/worktree";
import { statusOf, STATUS_META } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { TabCloseButton } from "@/components/TabCloseButton";
import { useAgentStore } from "@/lib/agentStore";
import { useGitBranches, useInvalidateGit } from "@/lib/queries";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { Project, Session } from "@/types";

interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeByProject: Record<string, string>;
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
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  notificationCount: number;
  onOpenNotifications: () => void;
}

/** Left navigation: projects as rows, the active one expanded to its sessions
 *  plus a project-scoped action row. Collapses to an icon rail (status dots
 *  survive) via the header toggle / ⌘B. */
export function Sidebar(props: SidebarProps) {
  const { collapsed } = props;
  // Status is read by the dots themselves, so one session going working
  // re-renders that dot instead of the whole sidebar.
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-64"
      )}
    >
      <SidebarHeader {...props} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
        {collapsed ? <Rail {...props} /> : <Tree {...props} />}
      </div>
      <SidebarFooter {...props} />
    </aside>
  );
}

/** Status dot for one session, subscribed on its own so a status change
 *  re-renders just this dot. Hidden while idle. */
const SessionStatusDot = memo(function SessionStatusDot({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "idle") return null;
  return <StatusDot status={status} />;
});

/** Text status ("working" / "needs you") beside a session row, subscribed on
 *  its own like the dot. Hidden while idle. */
const SessionStatusLabel = memo(function SessionStatusLabel({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "idle") return null;
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-medium uppercase tracking-wide",
        meta.text
      )}
    >
      {meta.label}
    </span>
  );
});

/** Leading bullet for a chat session: orange/amber while Claude works,
 *  otherwise a static green dot. */
const ChatStatusBullet = memo(function ChatStatusBullet({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "working" || status === "waiting") {
    return <StatusDot status={status} />;
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />;
});

/** Rolled-up status for a project row: working if any of its agents is,
 *  otherwise the first agent's own status. */
function ProjectStatusDot({
  sessions,
  className,
  hideIdle,
}: {
  sessions: Session[];
  className?: string;
  hideIdle?: boolean;
}) {
  const status = useAgentStore((s) => {
    const agents = sessions.filter((x) => x.kind === "agent");
    if (agents.some((x) => statusOf(s.statuses, x.id) === "working")) return "working";
    return agents[0] ? statusOf(s.statuses, agents[0].id) : "idle";
  });
  if (hideIdle && status === "idle") return null;
  return <StatusDot status={status} className={className} />;
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
    sessionsFor,
    expandAll,
    onSelectProject,
    onCloseProject,
    onPickProject,
    onNewAgent,
    onOpenSearch,
  } = props;

  return (
    <div className="px-1.5">
      <button
        onClick={onOpenSearch}
        className="mb-1.5 flex w-full items-center gap-2 rounded-md border border-input bg-secondary px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded bg-background/60 px-1 text-[10px] tabular-nums">
          ⌘K
        </kbd>
      </button>

      <div className="mb-0.5 flex items-center justify-between px-2 pt-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Projects
        </span>
        <button
          onClick={onPickProject}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Open project (⌘O)"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
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
                <ProjectStatusDot
                  sessions={pSessions}
                  className="absolute -bottom-0.5 -right-0.5 ring-2 ring-background"
                />
              </div>
              <span className="flex-1 truncate font-medium">
                {projectLabel(p)}
              </span>
              {p.worktree && (
                <BranchBadge
                  project={p}
                  branch={p.worktree.branch}
                  sessionsFor={sessionsFor}
                />
              )}
              {/* Active project only: newAgent targets whatever is active, so
                  offering it on another row would open the tab elsewhere. */}
              {active && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewAgent();
                  }}
                  className="rounded p-1 transition hover:bg-accent hover:text-foreground"
                  title="New agent tab (⌘T)"
                >
                  <SquarePen className="size-3.5" />
                </button>
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
                // Only the active project's session is on screen, so it is the
                // only one that may read as selected.
                activeId={active ? activeByProject[p.id] ?? null : null}
                projectId={p.id}
              />
            )}
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

/** Branch badge next to a project row: click to checkout another local
 *  branch. Branches only load once the menu opens. Guards the checkout when
 *  a chat/agent session in the project is still working. */
function BranchBadge({
  project,
  branch,
  sessionsFor,
}: {
  project: Project;
  branch: string;
  sessionsFor: (id: string) => Session[];
}) {
  const [open, setOpen] = useState(false);
  const branchesQuery = useGitBranches(project.path, open);
  const branches = branchesQuery.data ?? [];
  const invalidateGit = useInvalidateGit();

  async function checkout(name: string) {
    if (name === branch) return;
    const statuses = useAgentStore.getState().statuses;
    const busy = sessionsFor(project.id).some(
      (s) => statuses[s.id] === "working" || statuses[s.id] === "waiting"
    );
    if (busy) {
      const ok = await ask(
        `A chat is in progress in "${projectLabel(project)}". Switch to branch "${name}" anyway?`,
        { title: "Switch branch", kind: "warning" }
      );
      if (!ok) return;
    }
    try {
      await invoke<string>("git_checkout", { path: project.path, branch: name, create: false });
      invalidateGit(project.path);
    } catch (e) {
      toast.error("Checkout failed", { description: String(e) });
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 max-w-20 shrink cursor-pointer items-center gap-1 rounded bg-background/60 px-1 py-px text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`On branch ${branch} — click to switch`}
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>Checkout</DropdownMenuLabel>
        {branches.map((b) => (
          <DropdownMenuItem key={b} disabled={b === branch} onSelect={() => checkout(b)}>
            <span className="truncate">{b}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The active project's sessions, indented and drag-reorderable. */
function SessionList({
  sessions,
  activeId,
  projectId,
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
  const [showAll, setShowAll] = useState(false);

  const LIMIT = 8;
  const shown = showAll ? sessions : sessions.slice(0, LIMIT);

  return (
    <ul className="ml-3 mt-0.5 border-l pl-1.5">
      {shown.map((s) => {
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
              // Only the session on screen gets the filled treatment;
              // hover stays deliberately fainter so it can't be mistaken for it.
              active
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/40",
              dragId === s.id && "opacity-40",
              overId === s.id && "ring-1 ring-primary/60"
            )}
          >
            {s.kind === "agent" ? (
              <Bot className="size-4 shrink-0 opacity-70" />
            ) : s.kind === "chat" ? (
              <ChatStatusBullet id={s.id} />
            ) : (
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            )}
            {(s.kind === "agent" || s.kind === "chat") && (
              <SessionStatusLabel id={s.id} />
            )}
            <span className="flex-1 truncate">
              {s.kind === "dev" ? `dev:${s.label}` : s.label}
            </span>
            {s.kind === "agent" && <SessionStatusDot id={s.id} />}
            <TabCloseButton
              active={active}
              title={s.kind === "dev" ? "Stop" : "Close"}
              onClose={() => onCloseSession(s.id)}
            />
          </li>
        );
      })}
      {sessions.length > LIMIT && (
        <li>
          <button
            onClick={() => setShowAll((v) => !v)}
            className="px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {showAll ? "Show less" : `Show ${sessions.length - LIMIT} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/** Icon rail: one avatar per project, status dot preserved. */
function Rail({
  projects,
  activeProjectId,
  sessionsFor,
  onSelectProject,
  onPickProject,
}: SidebarProps) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {projects.map((p) => {
        const active = p.id === activeProjectId;
        const pSessions = sessionsFor(p.id);
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
            <ProjectStatusDot
              sessions={pSessions}
              hideIdle
              className="absolute -right-0.5 -top-0.5 ring-2 ring-sidebar"
            />
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

function SidebarFooter({
  collapsed,
  onOpenSettings,
  notificationCount,
  onOpenNotifications,
}: SidebarProps) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center border-t",
        collapsed
          ? "flex-col justify-center gap-0.5 py-1"
          : "h-10 justify-between px-2.5"
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
      <button
        onClick={onOpenNotifications}
        className="relative flex items-center gap-2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Notifications"
      >
        <Bell className="size-5" />
        {notificationCount > 0 &&
          (collapsed ? (
            <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />
          ) : (
            <span className="rounded bg-primary/20 px-1 text-[10px] tabular-nums text-primary">
              {notificationCount}
            </span>
          ))}
      </button>
    </footer>
  );
}
