import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewThreadHeading } from "@/components/chat/NewThreadHeading";
import type { Project } from "@/types";

afterEach(cleanup);

const project = (id: string, path: string): Project => ({
  id,
  path,
  workspace: null,
  icon: null,
  threads: [],
  worktree: null,
});

const PROJECTS = [project("a", "/code/emberyx"), project("b", "/code/glacies")];

const renderHeading = (
  props: Partial<Parameters<typeof NewThreadHeading>[0]> = {},
) =>
  render(
    <NewThreadHeading
      cwd="/code/emberyx"
      icon={null}
      root="/code/emberyx"
      projects={PROJECTS}
      onPickProject={() => {}}
      {...props}
    />,
  );

describe("NewThreadHeading", () => {
  it("names the current project as the switcher's trigger", () => {
    renderHeading();
    expect(screen.getByRole("heading").textContent).toContain(
      "What should we build in",
    );
    expect(screen.getByRole("button").textContent).toContain("emberyx");
  });

  it("shows the project's own icon when it ships one", () => {
    const { container } = renderHeading({ icon: "data:image/png;base64,AA" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AA",
    );
  });

  it("starts a thread in the project picked from the menu", async () => {
    const onPickProject = vi.fn();
    renderHeading({ onPickProject });
    const trigger = screen.getByRole("button");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /glacies/ }));
    await waitFor(() => expect(onPickProject).toHaveBeenCalledWith("b"));
  });
});
