const KEY = "emberyx.openProjects";

export interface OpenProject {
  path: string;
  worktree: { repoRoot: string; branch: string } | null;
}

export interface OpenProjects {
  projects: OpenProject[];
  activePath: string | null;
}

const empty = (): OpenProjects => ({ projects: [], activePath: null });

export function getOpenProjects(): OpenProjects {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as OpenProjects;
    // Guard against a well-formed but wrong-shaped value from an older build.
    return Array.isArray(parsed.projects) ? parsed : empty();
  } catch {
    return empty();
  }
}

export function saveOpenProjects(
  projects: OpenProject[],
  activePath: string | null
): void {
  localStorage.setItem(KEY, JSON.stringify({ projects, activePath }));
}
