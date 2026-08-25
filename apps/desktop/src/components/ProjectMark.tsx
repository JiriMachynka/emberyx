import { cn } from "@/lib/utils";
import type { ProjectGlyph } from "@/lib/projectGlyph";
import type { Project } from "@/types";

/** The project's own icon when it ships one, else a toned letter tile. */
export function ProjectMark({
  project,
  glyph,
  small,
}: {
  project: Project;
  glyph: ProjectGlyph;
  small?: boolean;
}) {
  const size = small ? "size-3.5" : "size-4";
  if (project.icon) {
    return (
      <img
        src={project.icon}
        alt=""
        className={cn("shrink-0 rounded-[5px] object-contain", size)}
      />
    );
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-[5px] font-semibold",
        size,
        small ? "text-[8px]" : "text-[9px]",
        glyph.tone,
      )}
    >
      {glyph.letter}
    </span>
  );
}
