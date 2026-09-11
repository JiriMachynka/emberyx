import { cn } from "@/lib/utils";
import { SidebarHeader } from "@/components/sidebar/SidebarHeader";
import { Tree } from "@/components/sidebar/Tree";
import { Rail } from "@/components/sidebar/Rail";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import type { SidebarProps } from "@/components/sidebar/types";

/** Left navigation: projects as rows, the active one expanded to its sessions
 *  plus a project-scoped action row. Collapses to an icon rail (status dots
 *  survive) via the header toggle / ⌘B. */
export function Sidebar(props: SidebarProps) {
  const { collapsed, fontFamily, settingsOpen } = props;
  // Status is read by the dots themselves, so one session going working
  // re-renders that dot instead of the whole sidebar.
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
