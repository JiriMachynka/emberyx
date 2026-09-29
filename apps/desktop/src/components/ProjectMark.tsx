import { cn } from "@/lib/utils";
import type { ProjectGlyph } from "@/lib/projectGlyph";
import type { Project } from "@/types";

/** The project's own icon when it ships one, else a toned letter tile. */
export function ProjectMark({
  project,
  glyph,
  small,
  className,
}: {
  project: Pick<Project, "icon">;
  glyph: ProjectGlyph;
  small?: boolean;
  className?: string;
}) {
  const size = small ? "size-3.5" : "size-4";
  if (project.icon) {
    return (
      <img
        src={project.icon}
        alt=""
        className={cn("shrink-0 rounded object-contain", size, className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded font-semibold",
        size,
        small ? "text-3xs" : "text-3xs",
        glyph.tone,
        className,
      )}
    >
      {glyph.letter}
    </span>
  );
}
