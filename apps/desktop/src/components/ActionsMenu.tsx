import { ChevronDown, Pencil, Play, Plus, Square, SquareArrowOutUpRight } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { IDE_LABEL, buildIdeCommand } from "@/lib/ide";
import { loadSettings } from "@/lib/settings";
import type { ProjectAction } from "@/lib/actions";

interface ActionsMenuProps {
  /** Project root, for "Open in <editor>". */
  projectPath: string;
  actions: ProjectAction[];
  running: boolean;
  onRun: (action: ProjectAction) => void;
  onEdit: (action: ProjectAction) => void;
  onAdd: () => void;
  onStop: () => void;
}

/** Top-bar menu of project actions: run one, edit it, or add a new one.
 *  Replaces the old detection-driven Dev split button. */
export function ActionsMenu({
  projectPath,
  actions,
  running,
  onRun,
  onEdit,
  onAdd,
  onStop,
}: ActionsMenuProps) {
  return (
    <div className="flex items-center gap-1">
      {running && (
        <Button variant="ghost" size="sm" onClick={onStop} title="Stop running">
          <Square className="size-3.5 fill-current" />
          Stop
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={running ? "secondary" : "ghost"}
            size="sm"
            title={running ? "An action is running" : "Run an action"}
          >
            {running ? (
              <span className="size-1.5 shrink-0 animate-ember-pulse rounded-full bg-primary" />
            ) : (
              <Play className="size-3.5" />
            )}
            <span className={cn(running && "text-primary")}>
              {running ? "Running" : "Run"}
            </span>
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {actions.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No actions yet.
            </div>
          )}
          {actions.map((a) => (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => onRun(a)}
              className="group justify-between gap-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Play className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{a.name}</span>
              </span>
              <button
                type="button"
                title="Edit action"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(a);
                }}
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                <Pencil className="size-3" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onAdd}>
            <Plus className="size-3.5" />
            Add action…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <OpenInIdeItem projectPath={projectPath} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Hand the project to the configured external editor. Settings are read on
 *  click rather than held as a prop: this is the only place that needs them,
 *  and a stale editor choice would send the project to the wrong app. */
function OpenInIdeItem({ projectPath }: { projectPath: string }) {
  const openInIde = async () => {
    const { ide, ideCustomCommand } = loadSettings();
    const command = buildIdeCommand(ide, { project: projectPath }, ideCustomCommand);
    if (!command) {
      toast.error("No editor configured", {
        description: "Set a custom command in Settings → Connections.",
      });
      return;
    }
    try {
      await invoke("open_in_ide", { ...command });
    } catch (e) {
      toast.error(`Couldn't open ${IDE_LABEL[ide]}`, { description: String(e) });
    }
  };
  return (
    <DropdownMenuItem onSelect={() => void openInIde()}>
      <SquareArrowOutUpRight className="size-3.5" />
      {`Open in ${IDE_LABEL[loadSettings().ide]}`}
    </DropdownMenuItem>
  );
}
