import { beforeEach, describe, expect, it } from "vitest";
import { getFavorites, shortcutFor, toggleFavorite } from "./modelFavorites";

beforeEach(() => localStorage.clear());

describe("favorites", () => {
  it("starts empty", () => {
    expect(getFavorites()).toEqual([]);
  });

  it("stars and unstars", () => {
    expect(toggleFavorite("claude-opus-5")).toEqual(["claude-opus-5"]);
    expect(getFavorites()).toEqual(["claude-opus-5"]);
    expect(toggleFavorite("claude-opus-5")).toEqual([]);
  });

  // Shortcut numbers are read off this order, so a new star must not renumber
  // the ones already in the user's fingers.
  it("appends new stars rather than prepending them", () => {
    toggleFavorite("a");
    expect(toggleFavorite("b")).toEqual(["a", "b"]);
  });

  it("survives a corrupt store", () => {
    localStorage.setItem("emberyx.modelFavorites", "{not json");
    expect(getFavorites()).toEqual([]);
  });

  it("ignores non-string entries", () => {
    localStorage.setItem("emberyx.modelFavorites", JSON.stringify(["a", 3, null]));
    expect(getFavorites()).toEqual(["a"]);
  });
});

describe("shortcutFor", () => {
  it("numbers the first nine", () => {
    expect(shortcutFor(0)).toBe("⌘1");
    expect(shortcutFor(8)).toBe("⌘9");
    expect(shortcutFor(9)).toBeNull();
  });
});
