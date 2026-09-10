import { describe, expect, it } from "vitest";
import { DIFF_THEME } from "@/lib/diffView";

describe("DIFF_THEME", () => {
  it("fills both pierre light-dark token slots", () => {
    // Pierre paints with light-dark(--token-light, --token-dark). A single
    // "vesper" string only populated the dark slot, so a light OS appearance
    // left every token the same inherited color.
    expect(DIFF_THEME.dark).toBe("vesper");
    expect(DIFF_THEME.light).toBe("vesper");
  });
});
