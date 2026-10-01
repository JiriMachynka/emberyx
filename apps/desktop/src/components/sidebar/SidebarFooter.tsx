import { ArrowLeft, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { SidebarProps } from "./types";

export function SidebarFooter({
  collapsed,
  onOpenSettings,
  settingsOpen,
  onBackFromSettings,
}: SidebarProps) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center",
        collapsed ? "justify-center py-1" : "px-2 py-1"
      )}
    >
      {settingsOpen ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBackFromSettings}
          title="Back"
          className="text-muted-foreground"
        >
          <ArrowLeft />
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          title="Settings"
          className="text-muted-foreground"
        >
          <Settings />
        </Button>
      )}
    </footer>
  );
}
