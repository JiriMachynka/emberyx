import { describe, expect, it } from "vitest";
import { glyphFor } from "./projectGlyph";

describe("glyphFor", () => {
  it("takes the first letter of the directory name", () => {
    expect(glyphFor("/Users/jiri/Desktop/Personal/emberyx").letter).toBe("E");
  });

  it("ignores a trailing slash", () => {
    expect(glyphFor("/repo/rufruf-frontend/").letter).toBe("R");
  });

  // A dotfile-named repo would otherwise show "." as its identity.
  it("skips leading punctuation", () => {
    expect(glyphFor("/repo/.config").letter).toBe("C");
    expect(glyphFor("/repo/---").letter).toBe("?");
  });

  it("gives one project the same tone every time", () => {
    expect(glyphFor("/repo/a").tone).toBe(glyphFor("/repo/a").tone);
  });

  it("does not give every project the same tone", () => {
    const tones = new Set(
      ["/a", "/b", "/c", "/d", "/e", "/f", "/g"].map((p) => glyphFor(p).tone)
    );
    expect(tones.size).toBeGreaterThan(1);
  });
});
