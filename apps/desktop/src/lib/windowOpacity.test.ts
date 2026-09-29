import { describe, expect, it } from "vitest";
import { applyTheme, themeById } from "@/lib/themes";
import {
  applyWindowOpacity,
  clampWindowOpacity,
  WINDOW_OPACITY_MAX,
  WINDOW_OPACITY_MIN,
  WINDOW_OPACITY_OPTIONS,
} from "@/lib/windowOpacity";

describe("clampWindowOpacity", () => {
  it("keeps a value in range", () => {
    expect(clampWindowOpacity(80)).toBe(80);
    expect(clampWindowOpacity(WINDOW_OPACITY_MIN)).toBe(WINDOW_OPACITY_MIN);
    expect(clampWindowOpacity(WINDOW_OPACITY_MAX)).toBe(WINDOW_OPACITY_MAX);
  });

  it("clamps and rounds", () => {
    expect(clampWindowOpacity(0)).toBe(WINDOW_OPACITY_MIN);
    expect(clampWindowOpacity(200)).toBe(WINDOW_OPACITY_MAX);
    expect(clampWindowOpacity(80.4)).toBe(80);
    expect(clampWindowOpacity(Number.NaN)).toBe(WINDOW_OPACITY_MAX);
  });

  it("snaps a free-form value to an offered step", () => {
    expect(clampWindowOpacity(72)).toBe(70);
    expect(clampWindowOpacity(75)).toBe(80);
    expect(WINDOW_OPACITY_OPTIONS.every((n) => clampWindowOpacity(n) === n)).toBe(true);
  });
});

describe("WINDOW_OPACITY_OPTIONS", () => {
  it("runs from solid down to the floor", () => {
    expect(WINDOW_OPACITY_OPTIONS).toEqual([100, 90, 80, 70, 60, 50]);
  });
});

describe("applyWindowOpacity", () => {
  it("writes alpha onto chrome tokens below 100%", () => {
    applyTheme("ember");
    applyWindowOpacity(80, "ember");
    const ember = themeById("ember");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe(
      `${ember.tokens["--background"].slice(0, -1)} / 0.8)`
    );
    expect(document.documentElement.style.getPropertyValue("--sidebar")).toBe(
      `${ember.tokens["--sidebar"].slice(0, -1)} / 0.8)`
    );
    expect(document.documentElement.style.getPropertyValue("--card")).toBe(
      ember.tokens["--card"]
    );
  });

  it("restores solid chrome at 100%", () => {
    applyTheme("ember");
    applyWindowOpacity(80, "ember");
    applyWindowOpacity(100, "ember");
    const ember = themeById("ember");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe(
      ember.tokens["--background"]
    );
  });
});
