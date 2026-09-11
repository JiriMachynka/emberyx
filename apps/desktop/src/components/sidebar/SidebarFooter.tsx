import { ArrowLeft, Bell, ChartColumn, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarProps } from "./types";

export function SidebarFooter({
  collapsed,
  onOpenSettings,
  settingsOpen,
  onBackFromSettings,
  onOpenUsage,
  notificationCount,
  onOpenNotifications,
}: SidebarProps) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center border-t",
        collapsed
          ? "flex-col justify-center gap-1 py-2"
          : "h-12 justify-between px-3"
      )}
    >
      <div className={cn("flex items-center", collapsed && "flex-col")}>
      {settingsOpen ? (
        <button
          onClick={onBackFromSettings}
          className="flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back"
        >
          <ArrowLeft className="size-5" />
          {!collapsed && <span>Back</span>}
        </button>
      ) : (
        <>
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Settings"
          >
            <Settings className="size-5" />
          </button>
          <button
            onClick={onOpenUsage}
            className="flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Usage"
          >
            <ChartColumn className="size-5" />
          </button>
        </>
      )}
      </div>
      <button
        onClick={onOpenNotifications}
        className="relative flex items-center gap-2 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Notifications"
      >
        <Bell className="size-5" />
        {notificationCount > 0 &&
          (collapsed ? (
            <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />
          ) : (
            <span className="rounded bg-primary/20 px-1 text-[10px] tabular-nums text-primary">
              {notificationCount}
            </span>
          ))}
      </button>
    </footer>
  );
}
