import { describe, expect, it } from "vitest";
import { DIFF_THEME, themeForSurface } from "@/lib/diffView";

describe("DIFF_THEME", () => {
  it("fills both pierre light-dark token slots", () => {
    // Pierre paints with light-dark(--token-light, --token-dark). A single
    // "vesper" string only populated the dark slot, so a light OS appearance
    // left every token the same inherited color.
    expect(DIFF_THEME.dark).toBe("vesper");
    expect(DIFF_THEME.light).toBe("vesper");
  });
});

describe("themeForSurface", () => {
  it("lifts the dim greys and hands the background to the box", async () => {
    const { default: theme } = await import("@shikijs/themes/vesper");
    const patched = themeForSurface(theme);
    expect(patched.colors?.["editor.background"]).toBe("transparent");
    const greys = new Map(
      patched.tokenColors?.map((rule) => [
        rule.settings?.foreground?.toLowerCase(),
        true,
      ])
    );
    expect(greys.has("#8b8b8b94")).toBe(false);
    expect(greys.has("#a0a0a0")).toBe(false);
    expect(greys.has("#b0b0b0")).toBe(true);
    expect(greys.has("#8f8f8f")).toBe(true);
    expect(greys.has("#ffc799")).toBe(true);
    expect(greys.has("#99ffe4")).toBe(true);
  });
});
