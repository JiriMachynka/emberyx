import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useProjects } from "@/hooks/useProjects";

const WT = { repoRoot: "/code/emberyx", branch: "fix/panes" };

describe("useProjects", () => {
  // The launch restore awaits `openProjectAt` per project, so the `projects`
  // render snapshot is stale for its whole duration. Opening a folder in that
  // window used to miss the entry already restored and create a second project
  // — with a second spawned agent — for the same path.
  it("dedupes by path within a single tick", () => {
    const { result } = renderHook(() => useProjects());
    let first = "";
    let second = "";
    act(() => {
      first = result.current.openProject("/code/emberyx").id;
      second = result.current.openProject("/code/emberyx").id;
    });

    expect(second).toBe(first);
    expect(result.current.projects).toHaveLength(1);
  });

  it("keeps a repo and its worktree as separate projects", () => {
    const { result } = renderHook(() => useProjects());
    let repoId = "";
    let wtId = "";
    act(() => {
      repoId = result.current.openProject("/code/emberyx").id;
    });
    act(() => {
      wtId = result.current.openProject("/code/.wt/emberyx-fix", WT).id;
    });

    expect(repoId).not.toBe(wtId);
    expect(result.current.projects.map((p) => p.path)).toEqual([
      "/code/emberyx",
      "/code/.wt/emberyx-fix",
    ]);
  });

  it("carries worktree metadata onto the project", () => {
    const { result } = renderHook(() => useProjects());
    act(() => {
      result.current.openProject("/code/.wt/emberyx-fix", WT);
    });

    expect(result.current.projects[0].worktree).toEqual(WT);
  });

  it("focuses an already-open path instead of duplicating it", () => {
    const { result } = renderHook(() => useProjects());
    let first = "";
    act(() => {
      first = result.current.openProject("/code/emberyx").id;
      result.current.openProject("/code/other");
    });

    let again: { id: string; isNew: boolean } = { id: "", isNew: true };
    act(() => {
      again = result.current.openProject("/code/emberyx");
    });

    expect(again).toEqual({ id: first, isNew: false });
    expect(result.current.projects).toHaveLength(2);
    expect(result.current.activeProjectId).toBe(first);
  });

  it("adopts worktree metadata for a path opened earlier as a plain folder", () => {
    const { result } = renderHook(() => useProjects());
    act(() => {
      result.current.openProject("/code/.wt/emberyx-fix");
    });
    expect(result.current.projects[0].worktree).toBeNull();

    act(() => {
      result.current.openProject("/code/.wt/emberyx-fix", WT);
    });
    expect(result.current.projects).toHaveLength(1);
    expect(result.current.projects[0].worktree).toEqual(WT);
  });

  it("leaves the repo open and active when the worktree closes", () => {
    const { result } = renderHook(() => useProjects());
    let repoId = "";
    let wtId = "";
    act(() => {
      repoId = result.current.openProject("/code/emberyx").id;
    });
    act(() => {
      wtId = result.current.openProject("/code/.wt/emberyx-fix", WT).id;
    });

    act(() => result.current.closeProject(wtId));

    expect(result.current.projects.map((p) => p.id)).toEqual([repoId]);
    expect(result.current.activeProjectId).toBe(repoId);
  });
});
