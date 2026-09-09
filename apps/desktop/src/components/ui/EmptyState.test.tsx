import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { EmptyState } from "@/components/ui/EmptyState";

// React only batches through act() when it knows it's in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = (node: React.ReactNode) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return host;
};

describe("EmptyState", () => {
  it("renders its message with no icon slot when none is given", () => {
    const host = render(<EmptyState>Nothing here.</EmptyState>);
    expect(host.textContent).toBe("Nothing here.");
    expect(host.querySelector("svg")).toBeNull();
  });

  it("renders the icon above the message", () => {
    const host = render(
      <EmptyState icon={<svg data-testid="icon" />}>Nothing here.</EmptyState>
    );
    const inner = host.firstElementChild;
    expect(inner?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(host.textContent).toBe("Nothing here.");
  });
});
