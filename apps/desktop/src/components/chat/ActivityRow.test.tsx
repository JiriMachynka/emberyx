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

  it("lists file work as one row per file, live or settled", () => {
    for (const live of [true, false]) {
      const view = render(<ActivityList live={live} activities={[write]} />);
      expect(view.container.textContent).toContain("Write");
      expect(view.container.textContent).toContain("src/a.ts");
      view.unmount();
    }
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

describe("ActivityList work rail", () => {
  it("renders thoughts and commands on one rail, in order", () => {
    const think: ActivityItem = {
      id: "t1",
      kind: "reasoning",
      title: "Thinking",
      output: "weighing the options",
      failed: false,
      complete: true,
    };
    const view = render(
      <ActivityList activities={[think, row({ id: "b1", complete: true, output: "ok" })]} />
    );
    // One rail holds both rows — reasoning is no longer split out of the list.
    const rail = view.container.querySelector(".work-rail");
    expect(rail).toBeTruthy();
    expect(rail?.textContent).toContain("Think");
    expect(rail?.textContent).toContain("Bash");
    // The old boxed panel is gone.
    expect(view.container.querySelector(".chat-work-panel")).toBeNull();
  });
});
