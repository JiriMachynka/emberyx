import { describe, expect, it } from "vitest";
import { PRELOAD_LANGUAGES } from "@/lib/pierreShiki";

describe("PRELOAD_LANGUAGES", () => {
  it("includes the names Pierre derives from filenames", () => {
    expect(PRELOAD_LANGUAGES).toContain("vue");
    expect(PRELOAD_LANGUAGES).toContain("tsx");
    expect(PRELOAD_LANGUAGES).toContain("typescript");
    expect(PRELOAD_LANGUAGES).toContain("zsh");
    expect(PRELOAD_LANGUAGES).toContain("rust");
  });
});
