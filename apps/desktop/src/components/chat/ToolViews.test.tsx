import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolBody } from "./ToolViews";

describe("ToolBody image", () => {
  it("renders a screenshot as an img, not a json blob", () => {
    const { container } = render(
      <ToolBody part={{ kind: "image", src: "data:image/png;base64,AAAA" }} />
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(container.textContent).not.toContain("AAAA");
  });
});
