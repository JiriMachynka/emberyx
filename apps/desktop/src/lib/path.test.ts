import { describe, expect, it } from "vitest";
import { basename, dirname } from "@/lib/path";

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(basename("c.ts")).toBe("c.ts");
  });

  it("ignores a trailing slash", () => {
    expect(basename("/a/b/")).toBe("b");
  });

  it("falls back to the input when there is no segment", () => {
    expect(basename("/")).toBe("/");
    expect(basename("")).toBe("");
  });
});

describe("dirname", () => {
  it("drops the last segment", () => {
    expect(dirname("/a/b/c.ts")).toBe("/a/b");
    expect(dirname("a/b")).toBe("a");
  });

  it("returns an empty string for a root-level file", () => {
    expect(dirname("/c.ts")).toBe("");
  });

  it("leaves a bare name untouched", () => {
    expect(dirname("c.ts")).toBe("c.ts");
  });
});
