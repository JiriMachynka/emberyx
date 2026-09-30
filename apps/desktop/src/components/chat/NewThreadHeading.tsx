import { ChevronDown } from "lucide-react";
import { ProjectMark } from "@/components/ProjectMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename } from "@/lib/path";
import { glyphFor } from "@/lib/projectGlyph";
import { projectLabel } from "@/lib/worktree";
import type { Project } from "@/types";

const rootOf = (p: Project) => p.worktree?.repoRoot ?? p.path;

export function NewThreadHeading({
  cwd,
  icon,
  root,
  projects,
  onPickProject,
}: {
  cwd: string;
  icon: string | null;
  root: string;
  projects: Project[];
  onPickProject: (projectId: string) => void;
}) {
  return (
    <h2 className="text-center text-3xl font-medium tracking-tight text-balance text-foreground">
      What should we build in{" "}
      <DropdownMenu>
        <DropdownMenuTrigger className="cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ProjectMark
            project={{ icon }}
            glyph={glyphFor(root)}
            className="mr-1.5 inline-grid size-5 align-middle"
          />
          <span className="ember-text border-b-2 border-dotted border-primary">
            {basename(cwd)}
          </span>
          <ChevronDown className="ml-1 inline size-5 align-middle text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-56 text-base tracking-normal">
          {projects.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onPickProject(p.id)}>
              <ProjectMark project={p} glyph={glyphFor(rootOf(p))} />
              <span className="truncate">{projectLabel(p)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      ?
    </h2>
  );
}
