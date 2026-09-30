import { cn } from "@/lib/utils";
import { Rail } from "@/components/sidebar/Rail";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import { WorkspaceColumn } from "@/components/sidebar/WorkspaceColumn";
import type { SidebarProps } from "@/components/sidebar/types";

/** Left navigation: a project rail plus a Sessions / Explorer / Changes
 *  column. ⌘B hides the column; the rail stays. With "One flat list" there is
 *  no rail — the Sessions dropdown switches project and the settings gear sits
 *  at the foot of the column. A strip with just the gear only returns when the
 *  column isn't on screen (hidden, or replaced by Settings). */
export function Sidebar(props: SidebarProps) {
  const { fontFamily, settingsOpen, workspaceCollapsed, threadGrouping } = props;
  const flat = threadGrouping === "none";
  const columnShown = !settingsOpen && !workspaceCollapsed;
  const strip = !flat || !columnShown;

  return (
    <aside style={{ fontFamily }} className="flex shrink-0 bg-sidebar">
      {strip && (
        <div
          className={cn(
            "flex shrink-0 flex-col border-r border-white/[0.06]",
            flat ? "w-12" : "w-14"
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
            {!flat && <Rail {...props} />}
          </div>
          <SidebarFooter {...props} collapsed />
        </div>
      )}
      {settingsOpen ? (
        <div className="flex w-72 shrink-0 flex-col border-r border-white/[0.06]">
          <div
            id="settings-navigation"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1.5"
          />
        </div>
      ) : (
        !workspaceCollapsed && (
          <div className="flex w-72 shrink-0 flex-col border-r border-white/[0.06]">
            <WorkspaceColumn {...props} />
          </div>
        )
      )}
    </aside>
  );
}
