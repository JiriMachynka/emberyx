import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ActivityFileTree } from "@/components/chat/ActivityFileTree";
import type { ActivityItem } from "@/types";

afterEach(cleanup);

const write = (content: string, complete = false): ActivityItem => ({
  id: "w1",
  kind: "fileChange",
  title: "Write",
  arguments: JSON.stringify({ file_path: "src/a.ts", content }),
  displayTarget: "src/a.ts",
  failed: false,
  complete,
});

describe("ActivityFileTree", () => {
  it("streams a Write as a highlighted addition, not just the path", () => {
    const { container } = render(
      <ActivityFileTree live activities={[write("const x = 1;\n")]} />
    );
    expect(container.textContent).toContain("a.ts");
    expect(container.textContent).toContain("creating");
    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("const x = 1;");
    expect(container.querySelector("code")).not.toBeNull();
  });

  it("streams an Edit as a highlighted diff", () => {
    const edit: ActivityItem = {
      id: "e1",
      kind: "fileChange",
      title: "Edit",
      arguments: JSON.stringify({
        file_path: "src/a.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      }),
      displayTarget: "src/a.ts",
      failed: false,
      complete: false,
    };
    const { container } = render(<ActivityFileTree live activities={[edit]} />);
    expect(container.textContent).toContain("modifying");
    expect(container.textContent).toContain("-");
    expect(container.textContent).toContain("+");
    expect(container.textContent).toContain("const x = 1;");
    expect(container.textContent).toContain("const x = 2;");
  });
});
