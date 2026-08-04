import { fileIconName } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";

interface FileTypeIconProps {
  /** File name or path — a path lets ".config/…" style rules match. */
  path: string;
  className?: string;
}

/**
 * Material file icon, served from public/file-icons (see
 * scripts/generate-file-icons.ts). Colors come from the SVG, so it can't be tinted.
 */
export function FileTypeIcon({ path, className }: FileTypeIconProps) {
  return (
    <img
      src={`/file-icons/${fileIconName(path)}.svg`}
      alt=""
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}
