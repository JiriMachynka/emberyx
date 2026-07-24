import { describe, expect, it } from "vitest";
import { projectLabel, projectTitle } from "@/lib/worktree";
import type { Project } from "@/types";

function project(path: string, worktree: Project["worktree"] = null): Project {
  return {
    id: "p1",
    path,
    workspace: null,
    icon: null,
    threads: [],
    dokploy: null,
    worktree,
  };
}

describe("projectLabel", () => {
  it("uses the folder name for a plain project", () => {
    expect(projectLabel(project("/code/emberyx"))).toBe("emberyx");
  });

  it("pairs repo and branch for a worktree", () => {
    const p = project("/code/.worktrees/emberyx-fix", {
      repoRoot: "/code/emberyx",
      branch: "fix/panes",
    });
    expect(projectLabel(p)).toBe("emberyx · fix/panes");
  });

  it("truncates a very long branch but keeps both ends", () => {
    const branch = "feature/really-long-branch-name-that-never-ends";
    const label = projectLabel(
      project("/code/wt", { repoRoot: "/code/emberyx", branch })
    );
    expect(label.length).toBeLessThan(`emberyx · ${branch}`.length);
    expect(label.startsWith("emberyx · feature/")).toBe(true);
    expect(label).toContain("…");
    expect(label.endsWith(branch.slice(-6))).toBe(true);
  });
});

describe("projectTitle", () => {
  it("is just the path for a plain project", () => {
    expect(projectTitle(project("/code/emberyx"))).toBe("/code/emberyx");
  });

  it("appends the branch for a worktree", () => {
    const p = project("/code/wt", {
      repoRoot: "/code/emberyx",
      branch: "main",
    });
    expect(projectTitle(p)).toBe("/code/wt (main)");
  });
});
