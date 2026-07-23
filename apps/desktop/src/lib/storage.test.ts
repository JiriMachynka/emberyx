import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRecent, getRecents } from "@/lib/recents";
import { PANEL_MIN_WIDTH, getPanelWidth, setPanelWidth } from "@/lib/panels";
import { getSidebarCollapsed, setSidebarCollapsed } from "@/lib/sidebar";
import { getProjectConfigs, setProjectDevCommand } from "@/lib/projectConfig";

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
});
