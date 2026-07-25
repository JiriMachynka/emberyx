import { useMemo } from "react";
import { Bell, CheckCheck, CircleAlert, CircleCheck, CircleX, Trash2 } from "lucide-react";
import { SidePanel } from "@/components/SidePanel";
import { useAgentStore } from "@/lib/agentStore";
import type { AppNotification, NotificationKind } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const KIND_ICON = {
  done: CircleCheck,
  "needs-input": CircleAlert,
  error: CircleX,
} as const;

const KIND_TINT: Record<NotificationKind, string> = {
  done: "text-emerald-400",
  "needs-input": "text-amber-400",
  error: "text-red-400",
};

const MINUTE = 60_000;

function relativeTime(time: number, now: number): string {
  const diff = Math.max(0, now - time);
  if (diff < MINUTE) return "just now";
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < 24 * 60 * MINUTE) return `${Math.floor(diff / (60 * MINUTE))}h ago`;
  return `${Math.floor(diff / (24 * 60 * MINUTE))}d ago`;
}

/** Group preserving feed order, so projects sort by their newest notification. */
function groupByProject(list: AppNotification[]): [string, AppNotification[]][] {
  const groups = new Map<string, AppNotification[]>();
  for (const n of list) {
    const existing = groups.get(n.project);
    if (existing) existing.push(n);
    else groups.set(n.project, [n]);
  }
  return [...groups];
}

interface NotificationPanelProps {
  onClose: () => void;
  /** Jump to the session a notification came from. */
  onSelect: (session: string) => void;
}

/** Notification centre: every run that finished, errored, or is waiting on the
 *  user, grouped by project and newest first. */
export function NotificationPanel({ onClose, onSelect }: NotificationPanelProps) {
  const notifications = useAgentStore((s) => s.notifications);
  const markRead = useAgentStore((s) => s.markNotificationRead);
  const markAllRead = useAgentStore((s) => s.markNotificationsRead);
  const clear = useAgentStore((s) => s.clearNotifications);

  const groups = useMemo(() => groupByProject(notifications), [notifications]);
  // Rendered on open and on every feed change — close enough for "5m ago".
  const now = Date.now();

  return (
    <SidePanel
      storageKey="notifications"
      onClose={onClose}
      header={<span className="text-sm font-medium">Notifications</span>}
      actions={
        <>
          <button
            onClick={markAllRead}
            title="Mark all read"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <CheckCheck className="size-3.5" />
          </button>
          <button
            onClick={clear}
            title="Clear"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        </>
      }
    >
      {notifications.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <Bell className="size-5" />
          Nothing yet — finished runs and prompts land here.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map(([project, items]) => (
            <div key={project}>
              <div className="sticky top-0 bg-card px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {project}
              </div>
              {items.map((n) => (
                <Row
                  key={n.id}
                  notification={n}
                  now={now}
                  onClick={() => {
                    markRead(n.id);
                    onSelect(n.session);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </SidePanel>
  );
}

function Row({
  notification,
  now,
  onClick,
}: {
  notification: AppNotification;
  now: number;
  onClick: () => void;
}) {
  const Icon = KIND_ICON[notification.kind];
  const unread = !notification.read;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 border-b border-l-2 border-border/50 px-3 py-2 text-left hover:bg-muted/50",
        unread ? "border-l-primary bg-primary/5" : "border-l-transparent"
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", KIND_TINT[notification.kind])} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              unread ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            {notification.title}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {relativeTime(notification.time, now)}
          </span>
        </span>
        {notification.body && (
          <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
            {notification.body}
          </span>
        )}
      </span>
    </button>
  );
}
