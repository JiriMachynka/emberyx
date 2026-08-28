import { describe, expect, it } from "vitest";
import { withGlyphFallback } from "@/lib/terminalFont";

describe("withGlyphFallback", () => {
  it("puts the Nerd Fonts ahead of the generic tail, behind the chosen face", () => {
    const out = withGlyphFallback(
      '"Geist Mono Variable", ui-monospace, Menlo, monospace'
    );
    const families = out.split(", ");
    expect(families[0]).toBe('"Geist Mono Variable"');
    expect(families.indexOf('"MesloLGS NF"')).toBeLessThan(
      families.indexOf("ui-monospace")
    );
    // Everything the stack already named survives, in order.
    expect(families.filter((f) => !f.includes("Nerd") && !f.includes("NF"))).toEqual([
      '"Geist Mono Variable"',
      "ui-monospace",
      "Menlo",
      "monospace",
    ]);
  });

  it("appends when the stack has no generic family to sit in front of", () => {
    const out = withGlyphFallback('"Fira Code"');
    expect(out.startsWith('"Fira Code", "MesloLGS NF"')).toBe(true);
  });

  it("doesn't repeat a Nerd Font the user already picked", () => {
    const out = withGlyphFallback('"MesloLGS NF", monospace');
    expect(out.split(", ").filter((f) => f === '"MesloLGS NF"')).toHaveLength(1);
    expect(out.startsWith('"MesloLGS NF"')).toBe(true);
  });

  it("normalises spacing without dropping anything", () => {
    expect(withGlyphFallback("Menlo ,  monospace").split(", ")[0]).toBe("Menlo");
  });
});
