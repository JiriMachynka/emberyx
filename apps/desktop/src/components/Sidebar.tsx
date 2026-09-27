import { cn } from "@/lib/utils";
import { SidebarHeader } from "@/components/sidebar/SidebarHeader";
import { Tree } from "@/components/sidebar/Tree";
import { Rail } from "@/components/sidebar/Rail";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import { WorkspaceColumn } from "@/components/sidebar/WorkspaceColumn";
import type { SidebarProps } from "@/components/sidebar/types";

/** Left navigation. Classic is one sidebar that collapses to a rail. Column
 *  keeps the rail always on and puts Sessions / Explorer / Changes beside it. */
export function Sidebar(props: SidebarProps) {
  const { collapsed, fontFamily, settingsOpen, workspaceLayout, workspaceCollapsed } =
    props;
  const column = workspaceLayout === "column";

  if (column) {
    return (
      <aside
        style={{ fontFamily }}
        className="flex shrink-0 bg-sidebar"
      >
        <div className="flex w-14 shrink-0 flex-col border-r border-white/[0.06]">
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
            <Rail {...props} />
          </div>
          <SidebarFooter {...props} collapsed />
        </div>
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

  return (
    <aside
      style={{ fontFamily }}
      className={cn(
        "flex shrink-0 flex-col border-r border-white/[0.06] bg-sidebar transition-[width] duration-200",
        collapsed ? "w-14" : "w-72"
      )}
    >
      <SidebarHeader {...props} />
      <div
        data-sidebar-scroll
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5"
      >
        {settingsOpen ? (
          <div id="settings-navigation" className="flex min-h-full flex-col" />
        ) : collapsed ? (
          <Rail {...props} />
        ) : (
          <Tree {...props} />
        )}
      </div>
      <SidebarFooter {...props} />
    </aside>
  );
}
