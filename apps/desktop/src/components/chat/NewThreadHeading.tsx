import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectMark } from "@/components/ProjectMark";
import { basename } from "@/lib/path";
import { glyphFor } from "@/lib/projectGlyph";
import { projectLabel } from "@/lib/worktree";
import type { Project } from "@/types";

const mark = (project: Pick<Project, "icon" | "path" | "worktree">, className?: string) => (
  <ProjectMark
    project={project}
    glyph={glyphFor(project.worktree?.repoRoot ?? project.path)}
    className={className}
  />
);

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
  const current = projects.find((project) => project.path === cwd);
  return (
    <h2 className="text-center text-3xl font-medium tracking-tight text-balance text-foreground">
      What should we build in{" "}
      <DropdownMenu>
        <DropdownMenuTrigger className="ember-text group inline-flex items-center gap-1.5 outline-none transition-colors focus-visible:rounded focus-visible:ring-1 focus-visible:ring-ring">
          {mark(current ?? { icon: null, path: cwd, worktree: null }, "size-5")}
          <span className="underline decoration-border underline-offset-4 transition-colors group-hover:decoration-foreground">
            {basename(cwd)}
          </span>
          <ChevronDown className="size-4 no-underline text-muted-foreground opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              disabled={project.path === cwd}
              onSelect={() => onSelectProject(project.id)}
            >
              {mark(project)}
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
              {mark({ icon: null, path, worktree: null })}
              {basename(path)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      ?
    </h2>
  );
}
