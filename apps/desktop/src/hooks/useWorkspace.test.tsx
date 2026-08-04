import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "@/hooks/useWorkspace";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { saveOpenProjects } from "@/lib/openProjects";
import { addRecent } from "@/lib/recents";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    cmd === "list_threads" ? Promise.resolve([]) : Promise.resolve(null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => Promise.resolve(null),
  ask: () => Promise.resolve(true),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(false),
  requestPermission: () => Promise.resolve("denied"),
  sendNotification: () => {},
}));

const WT = { repoRoot: "/code/emberyx", branch: "fix/panes" };

beforeEach(() => {
  localStorage.clear();
});

describe("useWorkspace launch restore", () => {
  it("reopens the stored projects and focuses the stored active one", async () => {
    saveOpenProjects(
      [
        { path: "/a", worktree: null },
        { path: "/wt", worktree: WT },
      ],
      "/a"
    );

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    // The active project is opened last, so it ends up focused.
    expect(result.current.projects.map((p) => p.path)).toEqual(["/wt", "/a"]);
    expect(result.current.activeProject?.path).toBe("/a");
    expect(result.current.revealed).toBe(true);
    expect(
      result.current.projects.find((p) => p.path === "/wt")?.worktree
    ).toEqual(WT);
  });

  // The default surface is chat, so a guard that only looks for kind "agent"
  // sees no primary session and starts a second one on every reopen.
  it("does not open a second primary session when reopening a project that already has one", async () => {
    saveOpenProjects([{ path: "/a", worktree: null }], "/a");

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    const id = result.current.projects[0].id;
    await waitFor(() => expect(result.current.sessionsFor(id)).toHaveLength(1));

    await act(() => result.current.openProjectAt("/a"));

    expect(result.current.projects).toHaveLength(1);
    expect(result.current.sessionsFor(id)).toHaveLength(1);
  });

  it("pre-warms the most recent project behind the welcome screen when nothing is stored", async () => {
    addRecent("/recent");

    const { result } = renderHook(() => useWorkspace(DEFAULT_SETTINGS));

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0].path).toBe("/recent");
    // Pre-warm stays hidden: no workspace revealed, no active project in the UI.
    expect(result.current.revealed).toBe(false);
    expect(result.current.activeProject).toBeNull();
  });
});
