import { useRef, useState } from "react";
import type { Project, Thread, WorkspaceInfo } from "@/types";

/** Owns the list of open projects and which one is active. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const counter = useRef(0);

  // Mirrored so the dedupe below is synchronous. `openProjectAt` is async and
  // the launch restore awaits it per project, so the `projects` render snapshot
  // is stale for the whole restore — opening a folder in that window used to
  // miss the entry already restored and create a second project, with a second
  // spawned agent, for the same path.
  const projectsRef = useRef<Project[]>([]);
  const commit = (update: (prev: Project[]) => Project[]): Project[] => {
    const next = update(projectsRef.current);
    projectsRef.current = next;
    setProjects(next);
    return next;
  };

  /**
   * Open a project, or focus it if its path is already open. Returns the
   * project id and whether it was newly created (caller starts the agent).
   */
  function openProject(
    path: string,
    worktree?: { repoRoot: string; branch: string }
  ): { id: string; isNew: boolean } {
    const existing = projectsRef.current.find((p) => p.path === path);
    if (existing) {
      // A worktree opened earlier as a plain folder gets relabelled.
      if (!existing.worktree && worktree) {
        commit((prev) =>
          prev.map((p) => (p.id === existing.id ? { ...p, worktree } : p))
        );
      }
      setActiveProjectId(existing.id);
      return { id: existing.id, isNew: false };
    }
    const id = `p${++counter.current}`;
    commit((prev) => [
      ...prev,
      {
        id,
        path,
        workspace: null,
        icon: null,
        threads: [],
        worktree: worktree ?? null,
      },
    ]);
    setActiveProjectId(id);
    return { id, isNew: true };
  }

  function setWorkspace(id: string, workspace: WorkspaceInfo) {
    commit((prev) =>
      prev.map((p) => (p.id === id ? { ...p, workspace } : p))
    );
  }

  function setIcon(id: string, icon: string | null) {
    commit((prev) =>
      prev.map((p) => (p.id === id ? { ...p, icon } : p))
    );
  }

  function setThreads(id: string, threads: Thread[]) {
    commit((prev) =>
      prev.map((p) => (p.id === id ? { ...p, threads } : p))
    );
  }

  function closeProject(id: string) {
    const next = commit((prev) => prev.filter((p) => p.id !== id));
    setActiveProjectId((cur) =>
      cur === id ? next[next.length - 1]?.id ?? null : cur
    );
  }

  return {
    projects,
    activeProjectId,
    setActiveProjectId,
    openProject,
    setWorkspace,
    setIcon,
    setThreads,
    closeProject,
  };
}
