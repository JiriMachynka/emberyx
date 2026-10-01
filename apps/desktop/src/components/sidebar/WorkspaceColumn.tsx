import { useEffect, useMemo, useState } from "react";
import { PanelLeftClose, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { Button } from "@/components/ui/button";
import { FileTree } from "@/components/editor/FileTree";
import {
  latestOpenFile,
  onOpenFileRequest,
  requestOpenFile,
} from "@/lib/openFileRequest";
import { gitStatusInterval, useGitChanges } from "@/lib/queries";
import type { WorkspaceTab } from "@/lib/sidebar";
import { SidebarFooter } from "./SidebarFooter";
import { Tree } from "./Tree";
import type { SidebarProps } from "./types";

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "sessions", label: "Sessions" },
  { id: "explorer", label: "Explorer" },
];

/** Sessions / Explorer — the column beside the project rail. Changes live in
 *  the Git view. */
export function WorkspaceColumn(props: SidebarProps) {
  const {
    projects,
    activeProjectId,
    workspaceTab,
    onWorkspaceTab,
    onToggleCollapse,
    onNewAgent,
    onOpenEditor,
  } = props;
  const project = projects.find((p) => p.id === activeProjectId);
  const [explorerFile, setExplorerFile] = useState<string | null>(latestOpenFile);
  const [reveal, setReveal] = useState(0);
  useEffect(
    () =>
      onOpenFileRequest((path) => {
        setExplorerFile(path);
        setReveal((n) => n + 1);
      }),
    []
  );
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
      <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <nav className="flex min-w-0 flex-1 gap-0.5 rounded-md bg-secondary/50 p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onWorkspaceTab(tab.id)}
              className={cn(
                "flex-auto whitespace-nowrap rounded-md px-1 py-1 text-xs font-medium transition-colors",
                workspaceTab === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onNewAgent}
          title="New thread"
          className="text-muted-foreground"
        >
          <SquarePen />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          title="Hide workspace (⌘B)"
          className="text-muted-foreground"
        >
          <PanelLeftClose />
        </Button>
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
              revealToken={reveal}
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
      </div>
      {/* With no rail (a flat list) the settings gear lives down here. */}
      {props.threadGrouping === "none" && <SidebarFooter {...props} />}
    </div>
  );
}
