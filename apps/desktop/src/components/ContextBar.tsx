import {
  Globe,
  GitPullRequest,
  PanelRight,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ProjectMark";
import { ActionsMenu } from "@/components/ActionsMenu";
import type { ProjectAction } from "@/lib/actions";
import { basename } from "@/lib/path";
import { glyphFor } from "@/lib/projectGlyph";
import { useGitRemoteHost } from "@/lib/queries";
import { FORGE_NOUN, isRemoteHost } from "@/lib/forge";
import type { Project, Session } from "@/types";

/** Fresh chats are labeled "chat" until a title exists; don't show that. */
const untitledLabel = (label: string) => label === "chat" || label === "agent";

interface ContextBarProps {
  activeProject: Project | null;
  agent: Session | undefined;
  devRunning: boolean;
  mrsOpen: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  devOpen: boolean;
  /** Running action output in this project — badge on the Output toggle. */
  devCount: number;
  onToggleDev: () => void;
  /** Opens the project settings pane. */
  onOpenProjectSettings: () => void;
  actions: ProjectAction[];
  onRunAction: (action: ProjectAction) => void;
  onEditAction: (action: ProjectAction) => void;
  onAddAction: () => void;
  onStopDev: () => void;
  onToggleMrs: () => void;
  dockOpen: boolean;
  onToggleDock: () => void;
}

/** Slim bar above the chat: project / thread title, plus the dock controls. */
export function ContextBar({
  activeProject,
  agent,
  devRunning,
  mrsOpen,
  previewOpen,
  onTogglePreview,
  devOpen,
  devCount,
  onToggleDev,
  onOpenProjectSettings,
  actions,
  onRunAction,
  onEditAction,
  onAddAction,
  onStopDev,
  onToggleMrs,
  dockOpen,
  onToggleDock,
}: ContextBarProps) {
  const remoteHost = useGitRemoteHost(activeProject?.path ?? "").data;

  const title =
    (agent?.resume &&
      activeProject?.threads.find((t) => t.id === agent.resume)?.title) ||
    (agent && !untitledLabel(agent.label) ? agent.label : null);
  const glyph = activeProject
    ? glyphFor(activeProject.worktree?.repoRoot ?? activeProject.path)
    : null;

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {activeProject && glyph && (
          <ProjectMark project={activeProject} glyph={glyph} />
        )}
        {activeProject && (
          <button
            type="button"
            onClick={onOpenProjectSettings}
            className="shrink-0 truncate font-medium hover:text-foreground"
            title="Project settings"
          >
            {basename(activeProject.path)}
          </button>
        )}
        {title && (
          <>
            <span className="shrink-0 text-muted-foreground/50">/</span>
            <span className="min-w-0 truncate text-muted-foreground">{title}</span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {activeProject && (
          <ActionsMenu
            projectPath={activeProject.path}
            actions={actions}
            running={devRunning}
            onRun={onRunAction}
            onEdit={onEditAction}
            onAdd={onAddAction}
            onStop={onStopDev}
          />
        )}
        {devCount > 0 && (
          <Button
            variant={devOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleDev}
            title="Action output"
          >
            <Terminal className="size-3.5" />
            Output
            <span className="rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-400">
              {devCount}
            </span>
          </Button>
        )}
        {activeProject && (
          <Button
            variant={previewOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onTogglePreview}
            title="Preview a running dev server"
          >
            <Globe className="size-3.5" />
            Preview
          </Button>
        )}
        {activeProject && remoteHost && isRemoteHost(remoteHost) && (
          <Button
            variant={mrsOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleMrs}
            title={FORGE_NOUN[remoteHost].many}
          >
            <GitPullRequest className="size-3.5" />
            {remoteHost === "github" ? "PRs" : "MRs"}
          </Button>
        )}
        {activeProject && (
          <Button
            variant={dockOpen ? "secondary" : "ghost"}
            size="icon"
            onClick={onToggleDock}
            title={dockOpen ? "Close dock" : "Open dock"}
          >
            <PanelRight className="size-3.5" />
          </Button>
        )}
      </div>
    </header>
  );
}
