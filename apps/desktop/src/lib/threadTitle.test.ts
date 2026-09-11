import { describe, expect, it } from "vitest";
import { TITLE_MAX, threadTitleFrom } from "@/lib/threadTitle";

describe("threadTitleFrom", () => {
  it("uses the opening prompt's first line", () => {
    expect(threadTitleFrom("Fix the parser\nplease")).toBe("Fix the parser");
  });

  it("skips a markdown fence and a heading mark", () => {
    expect(
      threadTitleFrom("```javascript\n# Continue: Emberyx performance work\nconst x = 1;")
    ).toBe("Continue: Emberyx performance work");
  });

  it("does not title a prompt that is only a fence", () => {
    expect(threadTitleFrom("```javascript")).toBe("");
  });

  it("caps a long first line rather than using the whole prompt", () => {
    expect(threadTitleFrom("word ".repeat(200)).length).toBe(TITLE_MAX);
  });
});
