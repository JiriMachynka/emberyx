import { beforeEach, describe, expect, it } from "vitest";
import {
  getSidebarCollapsed,
  getWorkspaceCollapsed,
  getWorkspaceTab,
  setSidebarCollapsed,
  setWorkspaceCollapsed,
  setWorkspaceTab,
} from "./sidebar";

beforeEach(() => {
  localStorage.clear();
});

describe("sidebar collapse flags", () => {
  it("classic and column collapse persist independently", () => {
    expect(getSidebarCollapsed()).toBe(false);
    expect(getWorkspaceCollapsed()).toBe(false);
    setSidebarCollapsed(true);
    setWorkspaceCollapsed(true);
    expect(getSidebarCollapsed()).toBe(true);
    expect(getWorkspaceCollapsed()).toBe(true);
    setSidebarCollapsed(false);
    expect(getWorkspaceCollapsed()).toBe(true);
  });
});

describe("workspace tab", () => {
  it("defaults to sessions and remembers per project", () => {
    expect(getWorkspaceTab("p1")).toBe("sessions");
    setWorkspaceTab("p1", "explorer");
    expect(getWorkspaceTab("p1")).toBe("explorer");
    expect(getWorkspaceTab("p2")).toBe("sessions");
  });

  it("opens on Sessions for a project last left on the old Changes tab", () => {
    // Changes moved into the Git view; a stored "changes" is not a tab now.
    localStorage.setItem(
      "emberyx.workspace.tabs",
      JSON.stringify({ p1: "changes", p2: "explorer" })
    );
    expect(getWorkspaceTab("p1")).toBe("sessions");
    expect(getWorkspaceTab("p2")).toBe("explorer");
  });
});
