import { describe, expect, it } from "vitest";
import { isSmallModel, largerModel, skillWireText } from "@/lib/jev";

describe("largerModel", () => {
  const catalog = [
    { value: "grok-4-fast" },
    { value: "grok-4" },
    { value: "grok-4-heavy" },
  ];

  it("stays put on a general model", () => {
    expect(largerModel("grok-4", catalog)).toBeNull();
  });

  it("bumps a fast/mini id to the first non-small catalog entry", () => {
    expect(largerModel("grok-4-fast", catalog)).toBe("grok-4");
    expect(isSmallModel("claude-haiku-4-5")).toBe(true);
  });

  it("does nothing when the catalog has only small ids", () => {
    expect(largerModel("haiku", [{ value: "haiku" }, { value: "flash" }])).toBeNull();
  });
});

describe("skillWireText", () => {
  it("leaves the prompt alone when no skill was chosen", () => {
    expect(skillWireText("fix the test", null)).toBe("fix the test");
  });

  it("prefixes a hint without rewriting the user's words", () => {
    expect(skillWireText("fix the test", "fe-design")).toContain("fe-design");
    expect(skillWireText("fix the test", "fe-design").endsWith("fix the test")).toBe(true);
  });
});
