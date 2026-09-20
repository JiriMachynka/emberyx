import { describe, expect, it } from "vitest";
import { gitStatusInterval } from "./queries";

describe("gitStatusInterval", () => {
  it("does not schedule porcelain for a cache subscriber", () => {
    expect(gitStatusInterval("read")).toBe(false);
    expect(gitStatusInterval("read", true)).toBe(false);
  });

  it("keeps the open diff tab on a 2s tick", () => {
    expect(gitStatusInterval("watch")).toBe(2_000);
    expect(gitStatusInterval("watch", true)).toBe(2_000);
  });

  it("polls the top-bar badge fast only while the agent is writing", () => {
    expect(gitStatusInterval("badge", true)).toBe(2_000);
    expect(gitStatusInterval("badge", false)).toBe(8_000);
  });
});
