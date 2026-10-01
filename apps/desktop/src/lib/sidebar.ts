const KEY = "emberyx.sidebar.collapsed";
const WORKSPACE_KEY = "emberyx.sidebar.workspaceCollapsed";
const TAB_KEY = "emberyx.workspace.tabs";

export type WorkspaceTab = "sessions" | "explorer";

// A stored "changes" tab (from before Changes moved into the Git view) is no
// longer a tab, and falls back to Sessions here.
const isWorkspaceTab = (value: string): value is WorkspaceTab =>
  value === "sessions" || value === "explorer";

const flag = (key: string, fallback = false): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return fallback;
  }
};

const setFlag = (key: string, value: boolean): void => {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Ignore storage failures; collapse state just won't persist.
  }
};

export function getSidebarCollapsed(): boolean {
  return flag(KEY);
}

export function setSidebarCollapsed(collapsed: boolean): void {
  setFlag(KEY, collapsed);
}

/** Column layout: hide the Sessions/Explorer/Changes column; the rail stays. */
export function getWorkspaceCollapsed(): boolean {
  return flag(WORKSPACE_KEY);
}

export function setWorkspaceCollapsed(collapsed: boolean): void {
  setFlag(WORKSPACE_KEY, collapsed);
}

const readTabMap = (): Record<string, WorkspaceTab> => {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, WorkspaceTab> = {};
    for (const [id, tab] of Object.entries(parsed)) {
      if (isWorkspaceTab(tab)) out[id] = tab;
    }
    return out;
  } catch {
    return {};
  }
};

export function getWorkspaceTab(projectId: string): WorkspaceTab {
  return readTabMap()[projectId] ?? "sessions";
}

export function setWorkspaceTab(projectId: string, tab: WorkspaceTab): void {
  try {
    const next = { ...readTabMap(), [projectId]: tab };
    localStorage.setItem(TAB_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures; the tab just won't persist.
  }
}
