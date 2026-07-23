import { describe, expect, it } from "vitest";
import { applyMention, mentionAt } from "@/lib/mentions";

describe("mentionAt", () => {
  it("opens on an @ at the start of the text", () => {
    expect(mentionAt("@src/a", 6)).toEqual({ start: 0, query: "src/a" });
  });

  it("opens on an @ that follows whitespace", () => {
    expect(mentionAt("look at @src/a", 14)).toEqual({ start: 8, query: "src/a" });
  });

  it("ignores an @ glued to the previous word", () => {
    expect(mentionAt("email me@example.com", 20)).toBeNull();
  });

  it("closes once a space is typed after the token", () => {
    expect(mentionAt("@src/a.ts now", 13)).toBeNull();
  });

  it("returns an empty query right after the @", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("returns null when there is no @ before the caret", () => {
    expect(mentionAt("plain text", 10)).toBeNull();
  });

  it("uses the last @ before the caret", () => {
    expect(mentionAt("@one @two", 9)).toEqual({ start: 5, query: "two" });
  });
});

describe("applyMention", () => {
  it("replaces the token with the full path and a trailing space", () => {
    const mention = mentionAt("see @src/a", 10)!;
    expect(applyMention("see @src/a", mention, "src/app.ts", 10)).toEqual({
      text: "see @src/app.ts ",
      caret: 16,
    });
  });

  it("keeps text that sits after the caret", () => {
    const mention = mentionAt("@a rest", 2)!;
    expect(applyMention("@a rest", mention, "src/a.ts", 2)).toEqual({
      text: "@src/a.ts  rest",
      caret: 10,
    });
  });
});
