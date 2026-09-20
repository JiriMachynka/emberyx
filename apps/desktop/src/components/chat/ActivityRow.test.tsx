import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ActivityRow } from "@/components/chat/ActivityRow";
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

afterEach(cleanup);

describe("ActivityRow", () => {
  it("opens the in-flight tool and closes it once the result lands", () => {
    const live = render(<ActivityRow activity={row()} />);
    expect(live.getByRole("button", { expanded: true })).toBeTruthy();
    live.unmount();

    const done = render(<ActivityRow activity={row({ complete: true, output: "ok" })} />);
    expect(done.getByRole("button", { expanded: false })).toBeTruthy();
  });
});
