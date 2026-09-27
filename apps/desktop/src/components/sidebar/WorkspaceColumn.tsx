import { useMemo, useState } from "react";
import { PanelLeftClose, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { FileTree } from "@/components/editor/FileTree";
import { requestOpenFile } from "@/lib/openFileRequest";
import { gitStatusInterval, useGitChanges } from "@/lib/queries";
import type { WorkspaceTab } from "@/lib/sidebar";
import { ChangesColumn } from "./ChangesColumn";
import { Tree } from "./Tree";
import type { SidebarProps } from "./types";

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "explorer", label: "Explorer" },
  { id: "changes", label: "Changes" },
];

/** Sessions / Explorer / Changes — the column beside the project rail. */
export function WorkspaceColumn(props: SidebarProps) {
  const {
    projects,
    activeProjectId,
    workspaceTab,
    onWorkspaceTab,
    onToggleCollapse,
    onNewAgent,
    onOpenEditor,
    onOpenReview,
    rightDock,
    onOpenWorktree,
    onRemoveWorktree,
    remoteHost,
  } = props;
  const project = projects.find((p) => p.id === activeProjectId);
  const [explorerFile, setExplorerFile] = useState<string | null>(null);
  const changes = useGitChanges(
    project?.path ?? "",
    !!project && workspaceTab === "explorer",
    gitStatusInterval("read")
  );
  const dirtyPaths = useMemo(() => {
    const root = project?.path;
    if (!root) return new Set<string>();
    return new Set((changes.data ?? []).map((f) => `${root}/${f.path}`));
  }, [project?.path, changes.data]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
        <nav className="flex min-w-0 flex-1 gap-0.5 rounded-md bg-secondary/50 p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onWorkspaceTab(tab.id)}
              className={cn(
                "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs font-medium transition-colors",
                workspaceTab === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={onNewAgent}
          title="New thread"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SquarePen className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Hide workspace (⌘B)"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="size-3.5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {workspaceTab === "sessions" && (
          <div className="min-h-0 flex-1 overflow-y-auto" data-sidebar-scroll>
            <Tree {...props} sessionsOnly />
          </div>
        )}
        {workspaceTab === "explorer" && project && (
          <div className="min-h-0 flex-1">
            <FileTree
              root={project.path}
              name={basename(project.path)}
              selected={explorerFile}
              dirtyPaths={dirtyPaths}
              onSelect={(path) => {
                setExplorerFile(path);
                requestOpenFile(path);
                onOpenEditor(path);
              }}
            />
          </div>
        )}
        {workspaceTab === "explorer" && !project && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Open a project to browse files
          </p>
        )}
        {workspaceTab === "changes" && project && (
          <div className="flex min-h-0 flex-1 flex-col">
            <ChangesColumn
              projectPath={project.path}
              rightDock={rightDock}
              remoteHost={remoteHost}
              onOpenReview={onOpenReview}
              onOpenWorktree={onOpenWorktree}
              onRemoveWorktree={onRemoveWorktree}
            />
          </div>
        )}
        {workspaceTab === "changes" && !project && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Open a project to see changes
          </p>
        )}
      </div>
    </div>
  );
}
