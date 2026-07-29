import type { WorkspaceInfo } from "@/types";

const KEY = "emberyx.projectActions";

/** A project-scoped command runnable from the top bar (and, later, a keybinding
 *  or on worktree creation). Keyed by the project's absolute path. */
export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  /** URL to open in the in-app preview when this action runs (phase 2). */
  previewUrl?: string;
  /** Run automatically whenever a worktree is created off this project. */
  runOnWorktreeCreate: boolean;
  /** Open the preview when this action runs (phase 2). */
  openPreviewOnRun: boolean;
}

type Store = Record<string, ProjectAction[]>;

function getStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** Actions the user has saved for a project, or undefined if they've never
 *  customised it (in which case detection-derived defaults stand in). */
export function getStoredActions(path: string): ProjectAction[] | undefined {
  return getStore()[path];
}

export function setStoredActions(
  path: string,
  actions: ProjectAction[]
): void {
  const store = getStore();
  if (actions.length) store[path] = actions;
  else delete store[path];
  localStorage.setItem(KEY, JSON.stringify(store));
}

let counter = 0;
export function newActionId(): string {
  counter += 1;
  return `act-${Date.now().toString(36)}-${counter}`;
}

const defaultAction = (name: string, command: string): ProjectAction => ({
  id: `default-${name.toLowerCase()}`,
  name,
  command,
  runOnWorktreeCreate: false,
  openPreviewOnRun: false,
});

/** Seed actions from workspace detection so a fresh project has Dev/Build/Start
 *  runnable without setup. Used only until the user saves their own. */
export function deriveDefaultActions(
  ws: WorkspaceInfo | null | undefined
): ProjectAction[] {
  if (!ws) return [];
  const out: ProjectAction[] = [];
  if (ws.allCommand) out.push(defaultAction("Dev", ws.allCommand));
  else if (ws.packages.length === 1) {
    out.push(defaultAction("Dev", ws.packages[0].devCommand));
  }
  if (ws.buildCommand) out.push(defaultAction("Build", ws.buildCommand));
  if (ws.startCommand) out.push(defaultAction("Start", ws.startCommand));
  return out;
}
