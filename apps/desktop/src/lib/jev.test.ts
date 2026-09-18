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

  it("does not jump from OpenCode Go flash to GitLab Duo", () => {
    const mixed = [
      { value: "gitlab/duo-chat-gpt-5-4-nano" },
      { value: "gitlab/duo-chat-fable-5-1" },
      { value: "opencode-go/deepseek-v4-flash" },
      { value: "opencode-go/qwen3.7-max" },
      { value: "opencode/big-pickle" },
    ];
    expect(largerModel("opencode-go/deepseek-v4-flash", mixed)).toBe(
      "opencode-go/qwen3.7-max"
    );
  });

  it("stays on a flash model when that vendor has no larger sibling", () => {
    expect(
      largerModel("opencode-go/deepseek-v4-flash", [
        { value: "gitlab/duo-chat-fable-5-1" },
        { value: "opencode-go/deepseek-v4-flash" },
        { value: "opencode-go/glm-5.3-flash" },
      ])
    ).toBeNull();
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
