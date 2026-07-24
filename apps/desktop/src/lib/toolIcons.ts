import {
  Blocks,
  Bot,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolIcon } from "@/lib/toolDisplay";

export const TOOL_ICONS: Record<ToolIcon, LucideIcon> = {
  task: Bot,
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  bash: Terminal,
  search: Search,
  globe: Globe,
  list: ListTodo,
  plan: ClipboardList,
  mcp: Blocks,
  tool: Wrench,
};

/** A steady per-tool hue so a run of cards is scannable without reading labels. */
export const TOOL_TINT: Record<ToolIcon, string> = {
  task: "text-violet-400",
  read: "text-sky-400",
  write: "text-emerald-400",
  edit: "text-amber-400",
  bash: "text-teal-300",
  search: "text-cyan-400",
  globe: "text-blue-400",
  list: "text-pink-400",
  plan: "text-indigo-400",
  mcp: "text-orange-400",
  tool: "text-muted-foreground",
};
