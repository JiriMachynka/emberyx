import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NewThreadHeading } from "@/components/chat/NewThreadHeading";
import { openFromKeyboard } from "@/test-utils/render";
import type { Project } from "@/types";

afterEach(cleanup);

const project = (
  path: string,
  extra: Partial<Project> = {},
): Project => ({
  id: path,
  path,
  workspace: null,
  icon: null,
  threads: [],
  worktree: null,
  ...extra,
});

describe("NewThreadHeading", () => {
  it("shows the current project's icon in the trigger", () => {
    render(
      <NewThreadHeading
        cwd="/code/emberyx"
        projects={[project("/code/emberyx", { icon: "data:image/png;base64,abc" })]}
        recentProjects={[]}
        onSelectProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,abc",
    );
  });

  it("lists each project with its icon or letter tile", () => {
    render(
      <NewThreadHeading
        cwd="/code/emberyx"
        projects={[
          project("/code/emberyx", { icon: "data:image/png;base64,abc" }),
          project("/code/logomint"),
        ]}
        recentProjects={["/code/pdfmod"]}
        onSelectProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    openFromKeyboard(screen.getByRole("button"));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items[0].querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,abc",
    );
    expect(items[1].querySelector("[aria-hidden]")?.textContent).toBe("L");
    expect(items[1].textContent).toContain("logomint");
    expect(items[2].querySelector("[aria-hidden]")?.textContent).toBe("P");
    expect(items[2].textContent).toContain("pdfmod");
  });
});
