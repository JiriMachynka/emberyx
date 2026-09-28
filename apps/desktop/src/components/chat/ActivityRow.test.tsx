import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ActivityList, ActivityRow } from "@/components/chat/ActivityRow";
import type { ActivityItem } from "@/types";

const row = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "bash-1",
  kind: "command",
  title: "Bash",
  arguments: JSON.stringify({ command: "ls" }),
  failed: false,
  complete: false,
  ...over,
});

afterEach(() => {
  cleanup();
});

describe("ActivityRow", () => {
  it("opens the in-flight tool and closes it once the result lands", () => {
    const live = render(<ActivityRow activity={row()} />);
    expect(live.getByRole("button", { expanded: true })).toBeTruthy();
    live.unmount();

    const done = render(<ActivityRow activity={row({ complete: true, output: "ok" })} />);
    expect(done.getByRole("button", { expanded: false })).toBeTruthy();
  });
});

describe("ActivityList file groups", () => {
  const write: ActivityItem = {
    id: "w1",
    kind: "fileChange",
    title: "Write",
    arguments: JSON.stringify({ file_path: "src/a.ts", content: "const x = 1;\n" }),
    displayTarget: "src/a.ts",
    failed: false,
    complete: true,
  };

  it("folds live file work into a tree and lists settled files as rows", () => {
    const live = render(<ActivityList live activities={[write]} />);
    expect(live.container.textContent).toContain("created");
    expect(live.container.textContent).not.toContain("Write");
    live.unmount();

    const settled = render(<ActivityList activities={[write]} />);
    expect(settled.container.textContent).not.toContain("created");
    expect(settled.container.textContent).toContain("Write");
    expect(settled.container.textContent).toContain("src/a.ts");
  });

  it("hides a finished command on a live turn and keeps the one still running", () => {
    const done = row({
      id: "done",
      kind: "search",
      title: "Grep",
      complete: true,
      output: "ok",
    });
    const running = row({ id: "run", complete: false });
    const view = render(<ActivityList live activities={[done, running]} />);
    expect(view.container.textContent).not.toContain("Grep");
    expect(view.container.textContent).toContain("Bash");
    expect(view.getByRole("button", { expanded: true })).toBeTruthy();
  });
});
