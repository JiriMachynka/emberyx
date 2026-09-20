import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename } from "@/lib/path";
import { projectLabel } from "@/lib/worktree";
import type { Project } from "@/types";

export function NewThreadHeading({
  cwd,
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
}: {
  cwd: string;
  projects: Project[];
  recentProjects: string[];
  onSelectProject: (projectId: string) => void;
  onOpenProject: (path: string) => void;
}) {
  const openProjectPaths = new Set(projects.map((project) => project.path));
  const recentOnly = recentProjects.filter((path) => !openProjectPaths.has(path));
  return (
    <h2 className="text-center text-3xl font-medium tracking-tight text-balance text-foreground">
      What should we build in{" "}
      <DropdownMenu>
        <DropdownMenuTrigger className="ember-text inline-flex items-center gap-1 underline decoration-border underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:rounded focus-visible:ring-1 focus-visible:ring-ring">
          {basename(cwd)}
          <ChevronDown className="size-4 no-underline text-muted-foreground opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              disabled={project.path === cwd}
              onSelect={() => onSelectProject(project.id)}
            >
              {projectLabel(project)}
            </DropdownMenuItem>
          ))}
          {recentOnly.length > 0 && projects.length > 0 && (
            <DropdownMenuSeparator />
          )}
          {recentOnly.map((path) => (
            <DropdownMenuItem
              key={path}
              onSelect={() => onOpenProject(path)}
              title={path}
            >
              {basename(path)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      ?
    </h2>
  );
}
