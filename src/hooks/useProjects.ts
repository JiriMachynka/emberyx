import { useRef, useState } from "react";
import type { DokployMatch, Project, Thread, WorkspaceInfo } from "@/types";

/** Owns the list of open projects and which one is active. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const counter = useRef(0);

  /**
   * Open a project, or focus it if its path is already open. Returns the
   * project id and whether it was newly created (caller starts the agent).
   */
  function openProject(path: string): { id: string; isNew: boolean } {
    const existing = projects.find((p) => p.path === path);
    if (existing) {
      setActiveProjectId(existing.id);
      return { id: existing.id, isNew: false };
    }
    const id = `p${++counter.current}`;
    setProjects((prev) => [
      ...prev,
      { id, path, workspace: null, threads: [], dokploy: null },
    ]);
    setActiveProjectId(id);
    return { id, isNew: true };
  }

  function setWorkspace(id: string, workspace: WorkspaceInfo) {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, workspace } : p))
    );
  }

  function setThreads(id: string, threads: Thread[]) {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, threads } : p))
    );
  }

  function setDokploy(id: string, dokploy: DokployMatch | null) {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, dokploy } : p))
    );
  }

  function closeProject(id: string) {
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id);
      setActiveProjectId((cur) =>
        cur === id ? next[next.length - 1]?.id ?? null : cur
      );
      return next;
    });
  }

  return {
    projects,
    activeProjectId,
    setActiveProjectId,
    openProject,
    setWorkspace,
    setThreads,
    setDokploy,
    closeProject,
  };
}
