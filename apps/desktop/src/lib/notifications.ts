const KEY = "emberyx.notifications";

export type NotificationKind = "done" | "needs-input" | "error";

export interface AppNotification {
  id: string;
  session: string;
  /** Basename of the session's cwd — used for grouping and display. */
  project: string;
  kind: NotificationKind;
  title: string;
  body: string;
  time: number;
  read: boolean;
}

/** Max entries kept, newest first. */
export const MAX_NOTIFICATIONS = 200;

const isNotification = (value: unknown): value is AppNotification => {
  if (typeof value !== "object" || value === null) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    typeof n.session === "string" &&
    typeof n.time === "number" &&
    (n.kind === "done" || n.kind === "needs-input" || n.kind === "error")
  );
};

export function loadNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Guard against a well-formed but wrong-shaped value from an older build.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isNotification);
  } catch {
    return [];
  }
}

export function saveNotifications(list: AppNotification[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_NOTIFICATIONS)));
}
