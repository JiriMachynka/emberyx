import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";

afterEach(cleanup);

describe("ThinkingBlock", () => {
  it("names a live 4 KB tail as the latest slice, not the whole thought", () => {
    const view = render(
      <ThinkingBlock
        text={"…the last few sentences of a long thought"}
        active
        timingKey="t1"
      />
    );
    expect(view.container.textContent).toContain("Thinking · latest");
  });

  it("keeps the plain Thinking label when the whole block is in hand", () => {
    const view = render(<ThinkingBlock text="short thought" active timingKey="t2" />);
    expect(view.container.textContent).toContain("Thinking");
    expect(view.container.textContent).not.toContain("latest");
  });
});
