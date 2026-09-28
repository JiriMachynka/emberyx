import { ArrowLeft, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarProps } from "./types";

export function SidebarFooter({
  collapsed,
  onOpenSettings,
  settingsOpen,
  onBackFromSettings,
}: SidebarProps) {
  const btn =
    "flex items-center gap-1.5 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

  return (
    <footer
      className={cn(
        "flex shrink-0 items-center border-t",
        collapsed ? "justify-center py-1.5" : "px-2 py-1"
      )}
    >
      {settingsOpen ? (
        <button
          onClick={onBackFromSettings}
          className={btn}
          title="Back"
        >
          <ArrowLeft className="size-4" />
          {!collapsed && <span className="text-xs">Back</span>}
        </button>
      ) : (
        <button
          onClick={onOpenSettings}
          className={btn}
          title="Settings"
        >
          <Settings className="size-5" />
        </button>
      )}
    </footer>
  );
}
