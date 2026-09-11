import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { DiffLine } from "@/components/diff/DiffLine";
import { highlightCached } from "@/lib/highlight";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DiffLine", () => {
  it("highlights on the first paint", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <DiffLine
          marker="+"
          code="const x = 1;"
          lang="javascript"
          tint=""
          highlight={highlightCached}
        />
      );
    });

    expect(host.innerHTML).toContain("color:");
    expect(host.textContent).toContain("const x = 1;");
  });
});
