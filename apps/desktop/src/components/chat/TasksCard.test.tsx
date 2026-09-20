import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TasksCard } from "@/components/chat/TasksCard";
import type { TodoItem } from "@/lib/toolDisplay";

afterEach(cleanup);

const items = (...rows: TodoItem[]): TodoItem[] => rows;

describe("TasksCard", () => {
  it("marks the in-progress task as the current step", () => {
    const view = render(
      <TasksCard
        planKey="p1"
        items={items(
          { status: "completed", text: "one" },
          { status: "in_progress", text: "two" },
          { status: "pending", text: "three" },
        )}
      />
    );
    const current = view.getByRole("listitem", { current: "step" });
    expect(current.textContent).toContain("two");
    expect(current.textContent).toContain("now");
  });

  it("tracks the next pending task when none is marked in progress", () => {
    const view = render(
      <TasksCard
        planKey="p2"
        collapsible
        items={items(
          { status: "completed", text: "one" },
          { status: "pending", text: "two" },
          { status: "pending", text: "three" },
        )}
      />
    );
    expect(view.getByRole("listitem", { current: "step" }).textContent).toContain(
      "two"
    );
    expect(view.getByRole("button", { expanded: false }).textContent).toContain(
      "two"
    );
  });

  it("does not mark a finished plan as in flight", () => {
    const view = render(
      <TasksCard
        planKey="p3"
        items={items(
          { status: "completed", text: "one" },
          { status: "completed", text: "two" },
        )}
      />
    );
    expect(view.queryByRole("listitem", { current: "step" })).toBeNull();
  });
});
