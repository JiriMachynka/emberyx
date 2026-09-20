import { describe, expect, it } from "vitest";
import { liveMarkdown } from "@/lib/liveMarkdown";

describe("liveMarkdown", () => {
  it("closes incomplete bold so a Stop does not unwrap it", () => {
    const { source, incomplete } = liveMarkdown("this is **bol");
    expect(incomplete).toBe(true);
    expect(source).toBe("this is **bol**");
  });

  it("leaves complete markdown alone, including a tilde range", () => {
    expect(liveMarkdown("this is **bold** text")).toEqual({
      source: "this is **bold** text",
      incomplete: false,
    });
    expect(liveMarkdown("20~25")).toEqual({ source: "20~25", incomplete: false });
  });

  it("flags an unclosed fence so the streaming extension can keep the block", () => {
    const open = liveMarkdown("```ts\nconst x = 1");
    expect(open.incomplete).toBe(true);
    expect(open.source).toContain("const x = 1");
    expect(liveMarkdown("```ts\nconst x = 1\n```").incomplete).toBe(false);
  });
});
