import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { DockPicker } from "@/components/DockPicker";
import { PICKER_OFFERS } from "@/lib/dock";

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

describe("DockPicker", () => {
  it("renders Terminal and Review as header buttons, with the blurb as the title", () => {
    const host = render(<DockPicker onPick={() => {}} />);
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Terminal", "Review"]);
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual(
      PICKER_OFFERS.map((o) => o.blurb)
    );
  });
});
