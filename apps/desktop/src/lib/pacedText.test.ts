import { describe, expect, it } from "vitest";
import { revealEnd } from "@/lib/pacedText";

describe("revealEnd", () => {
  it("stops at the end of the word the reveal reached", () => {
    expect(revealEnd("hello world", 2, true)).toBe(5);
    expect(revealEnd("hello world", 5, true)).toBe(5);
  });

  it("holds a still-streaming word back at the last whole one", () => {
    expect(revealEnd("hello world", 6, true)).toBe(6);
    expect(revealEnd("hello wor", 9, true)).toBe(6);
  });

  it("runs out once the stream is finished", () => {
    expect(revealEnd("hello wor", 9, false)).toBe(9);
    expect(revealEnd("hello world", 6, false)).toBe(11);
  });

  it("holds a whole unfinished word back rather than showing it part-written", () => {
    expect(revealEnd("hello", 5, true)).toBe(0);
    expect(revealEnd("hello ", 6, true)).toBe(6);
  });
});
