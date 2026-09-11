import { PanelLeftClose, PanelLeftOpen, Search, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarProps } from "./types";

export function SidebarHeader(props: SidebarProps) {
  const { collapsed, onToggleCollapse, threadView, onOpenSearch, onNewAgent } = props;

  // The cross-project inbox is its own surface: search and compose belong at
  // the top of it. Collapse stays here too — a footer toggle is easy to miss
  // once the thread list is long.
  if (threadView === "all" && !collapsed) {
    return (
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        <button
          onClick={onOpenSearch}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          <Search className="size-4 shrink-0" />
          <span className="truncate">Search</span>
        </button>
        <button
          onClick={onNewAgent}
          title="New thread"
          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
        >
          <SquarePen className="size-4" />
        </button>
        <button
          onClick={onToggleCollapse}
          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Collapse sidebar (⌘B)"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </header>
    );
  }

  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center border-b border-white/[0.06]",
        collapsed ? "justify-center" : "justify-between px-2.5"
      )}
    >
      {!collapsed && (
        <div className="flex items-center gap-2">
          <img src="/emberyx.png" alt="" className="size-5 rounded-[5px] shadow" />
          <span className="ember-text text-sm font-semibold tracking-tight">
            Emberyx
          </span>
        </div>
      )}
      <button
        onClick={onToggleCollapse}
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={collapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)"}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </button>
    </header>
  );
}
