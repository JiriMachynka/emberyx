import {
  FolderOpen,
  GitCompare,
  GitPullRequest,
  Globe,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { DockKind } from "@/lib/dock";

/** One icon per dock surface, shared by the tab strip, the + menu and the
 *  chooser — the same surface reading differently in three places is how a tab
 *  strip stops being scannable. */
export const DOCK_ICONS: Record<DockKind, LucideIcon> = {
  terminal: Terminal,
  files: FolderOpen,
  diff: GitCompare,
  preview: Globe,
  mrs: GitPullRequest,
  dev: SquareTerminal,
  projectSettings: SlidersHorizontal,
};
