import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRecent, getRecents } from "@/lib/recents";
import { getOpenProjects, saveOpenProjects } from "@/lib/openProjects";
import { PANEL_MIN_WIDTH, getPanelWidth, setPanelWidth } from "@/lib/panels";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import {
  cachedThreads,
  cacheThreads,
  mergeLiveThreads,
  resumableThreads,
} from "@/lib/threadCache";
import type { Thread } from "@/types";
import {
  getProjectConfigs,
  projectBackend,
  setProjectBackend,
  setProjectDevCommand,
} from "@/lib/projectConfig";

beforeEach(() => {
  localStorage.clear();
});

describe("recents", () => {
  it("starts empty and returns what was added, newest first", () => {
    expect(getRecents()).toEqual([]);
    addRecent("/a");
    addRecent("/b");
    expect(getRecents()).toEqual(["/b", "/a"]);
  });

  it("moves a re-opened path to the front without duplicating it", () => {
    addRecent("/a");
    addRecent("/b");
    expect(addRecent("/a")).toEqual(["/a", "/b"]);
  });

  it("keeps at most ten entries", () => {
    for (let i = 0; i < 15; i++) addRecent(`/p${i}`);
    const recents = getRecents();
    expect(recents).toHaveLength(10);
    expect(recents[0]).toBe("/p14");
  });

  it("recovers from corrupt storage", () => {
    localStorage.setItem("emberyx.recents", "{not json");
    expect(getRecents()).toEqual([]);
  });
});

describe("openProjects", () => {
  it("starts empty", () => {
    expect(getOpenProjects()).toEqual({ projects: [], activePath: null });
  });

  it("round-trips the open list and the active path", () => {
    saveOpenProjects(
      [
        { path: "/a", worktree: null },
        { path: "/b", worktree: null },
      ],
      "/b"
    );
    expect(getOpenProjects()).toEqual({
      projects: [
        { path: "/a", worktree: null },
        { path: "/b", worktree: null },
      ],
      activePath: "/b",
    });
  });

  it("preserves worktree metadata", () => {
    const worktree = { repoRoot: "/code/emberyx", branch: "fix/panes" };
    saveOpenProjects([{ path: "/code/.wt/emberyx-fix", worktree }], null);
    expect(getOpenProjects().projects[0].worktree).toEqual(worktree);
  });

  it("recovers from corrupt storage", () => {
    localStorage.setItem("emberyx.openProjects", "{not json");
    expect(getOpenProjects()).toEqual({ projects: [], activePath: null });
  });

  it("recovers from a stored value of the wrong shape", () => {
    localStorage.setItem("emberyx.openProjects", JSON.stringify(["/a"]));
    expect(getOpenProjects()).toEqual({ projects: [], activePath: null });
  });
});

describe("panel widths", () => {
  it("returns a default wider than the minimum when unset", () => {
    expect(getPanelWidth("changes")).toBeGreaterThan(PANEL_MIN_WIDTH);
  });

  it("round-trips a width, rounded to whole pixels", () => {
    setPanelWidth("changes", 420.6);
    expect(getPanelWidth("changes")).toBe(421);
  });

  it("keeps each panel's width separate", () => {
    setPanelWidth("changes", 400);
    setPanelWidth("usage", 500);
    expect(getPanelWidth("changes")).toBe(400);
    expect(getPanelWidth("usage")).toBe(500);
  });

  it("falls back to the default for a stored width below the minimum", () => {
    setPanelWidth("changes", PANEL_MIN_WIDTH - 1);
    expect(getPanelWidth("changes")).toBeGreaterThan(PANEL_MIN_WIDTH);
  });

  it("ignores a storage failure instead of throwing", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => setPanelWidth("changes", 400)).not.toThrow();
    spy.mockRestore();
  });
});

describe("sidebar collapse", () => {
  it("defaults to expanded", () => {
    expect(getSidebarCollapsed()).toBe(false);
  });

  it("round-trips both states", () => {
    setSidebarCollapsed(true);
    expect(getSidebarCollapsed()).toBe(true);
    setSidebarCollapsed(false);
    expect(getSidebarCollapsed()).toBe(false);
  });
});

describe("thread cache", () => {
  it("starts empty", () => {
    expect(cachedThreads("/a", "claude")).toEqual([]);
  });

  it("round-trips a thread list per project path and backend", () => {
    const threads: Thread[] = [
      { id: "s1", title: "Fix the parser", modified: 100 },
      { id: "s2", title: "Ship the sidebar", modified: 200 },
    ];
    cacheThreads("/a", "claude", threads);
    expect(cachedThreads("/a", "claude")).toEqual(threads);
    expect(cachedThreads("/b", "claude")).toEqual([]);
    expect(cachedThreads("/a", "opencode")).toEqual([]);
  });

  it("a later scan replaces the entry wholesale", () => {
    cacheThreads("/a", "claude", [{ id: "s1", title: "old", modified: 100 }]);
    cacheThreads("/a", "claude", [{ id: "s2", title: "new", modified: 200 }]);
    expect(cachedThreads("/a", "claude")).toEqual([
      { id: "s2", title: "new", modified: 200 },
    ]);
  });

  it("does not replay another backend's cache after a restart", () => {
    cacheThreads("/a", "opencode", [
      { id: "oc1", title: "OpenCode thread", modified: 100, provider: "opencode" },
    ]);
    expect(cachedThreads("/a", "claude")).toEqual([]);
  });

  it("recovers from corrupt storage", () => {
    localStorage.setItem("emberyx.threadCache", "{not json");
    expect(cachedThreads("/a", "claude")).toEqual([]);
  });

  it("recovers from a stored value of the wrong shape", () => {
    localStorage.setItem(
      "emberyx.threadCache",
      JSON.stringify({ "claude:/a": "nope" })
    );
    expect(cachedThreads("/a", "claude")).toEqual([]);
  });

  it("ignores a storage failure instead of throwing", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => cacheThreads("/a", "claude", [])).not.toThrow();
    spy.mockRestore();
  });

  it("does not replay a placeholder title from a previous listing", () => {
    cacheThreads("/a", "claude", [
      { id: "s1", title: "Fix the parser", modified: 100 },
      { id: "s2", title: "Imported thread", modified: 200, imported: true },
    ]);
    expect(cachedThreads("/a", "claude")).toEqual([
      { id: "s1", title: "Fix the parser", modified: 100 },
    ]);
    localStorage.setItem(
      "emberyx.threadCache",
      JSON.stringify({
        "claude:/a": [
          { id: "s2", title: "Imported thread", modified: 200, imported: true },
        ],
      })
    );
    expect(cachedThreads("/a", "claude")).toEqual([]);
  });
});

describe("resumableThreads", () => {
  it("will not resume a scanned Claude transcript on OpenCode", () => {
    const rows: Thread[] = [
      { id: "c1", title: "Claude jsonl", modified: 200 },
      { id: "o1", title: "OpenCode", modified: 100, provider: "opencode" },
    ];
    expect(resumableThreads(rows, "opencode").map((t) => t.id)).toEqual(["o1"]);
    expect(resumableThreads(rows, "claude").map((t) => t.id)).toEqual(["c1"]);
  });

  it("skips imported history — there is no provider conversation to continue", () => {
    expect(
      resumableThreads(
        [{ id: "i1", title: "Imported", modified: 1, imported: true }],
        "claude"
      )
    ).toEqual([]);
  });
});

describe("mergeLiveThreads", () => {
  it("keeps a pane-registered thread the scan has not written yet", () => {
    expect(
      mergeLiveThreads(
        [{ id: "disk", title: "on disk", modified: 1 }],
        [{ id: "live", title: "just started", modified: 2 }]
      ).map((t) => t.id)
    ).toEqual(["live", "disk"]);
  });

  it("does not duplicate a live thread the scan already listed", () => {
    const row = { id: "t1", title: "same", modified: 1 };
    expect(mergeLiveThreads([row], [row])).toEqual([row]);
  });
});

describe("project config", () => {
  it("starts empty", () => {
    expect(getProjectConfigs()).toEqual({});
  });

  it("stores a dev command per project path", () => {
    setProjectDevCommand("/a", "bun run dev");
    setProjectDevCommand("/b", "pnpm dev");
    expect(getProjectConfigs()).toEqual({
      "/a": { devCommand: "bun run dev" },
      "/b": { devCommand: "pnpm dev" },
    });
  });

  it("trims the command before storing it", () => {
    setProjectDevCommand("/a", "  bun run dev  ");
    expect(getProjectConfigs()["/a"].devCommand).toBe("bun run dev");
  });

  it("drops the entry entirely when cleared with a blank command", () => {
    setProjectDevCommand("/a", "bun run dev");
    expect(setProjectDevCommand("/a", "   ")).toEqual({});
  });

  it("clearing an unset project is a no-op", () => {
    expect(setProjectDevCommand("/never-set", "")).toEqual({});
  });

  it("persists across reads", () => {
    setProjectDevCommand("/a", "bun run dev");
    expect(JSON.parse(localStorage.getItem("emberyx.projectConfig")!)).toEqual({
      "/a": { devCommand: "bun run dev" },
    });
  });

  it("pins a backend per project and falls back to the global default", () => {
    expect(projectBackend("/a", "claude")).toBe("claude");
    setProjectBackend("/a", "codex");
    expect(projectBackend("/a", "claude")).toBe("codex");
    expect(projectBackend("/b", "claude")).toBe("claude");
  });

  it("clears the pin without losing the project's other fields", () => {
    setProjectDevCommand("/a", "bun run dev");
    setProjectBackend("/a", "codex");
    expect(setProjectBackend("/a", null)).toEqual({
      "/a": { devCommand: "bun run dev" },
    });
    expect(projectBackend("/a", "claude")).toBe("claude");
  });

  it("drops the entry when the pin was all it held", () => {
    setProjectBackend("/a", "codex");
    expect(setProjectBackend("/a", null)).toEqual({});
  });

  it("ignores a backend a newer build wrote and this one doesn't know", () => {
    localStorage.setItem(
      "emberyx.projectConfig",
      JSON.stringify({ "/a": { backend: "gemini" } })
    );
    expect(projectBackend("/a", "claude")).toBe("claude");
  });
});
