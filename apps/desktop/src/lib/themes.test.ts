import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, applyTheme, isThemeId, themeById } from "./themes";

describe("themes", () => {
  it("gives every theme the same token set", () => {
    const keys = Object.keys(THEMES[0].tokens).sort();
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort(), theme.id).toEqual(keys);
    }
  });

  it("applies a theme's tokens to :root", () => {
    applyTheme("phosphor");
    const root = document.documentElement.style;
    const phosphor = themeById("phosphor");
    expect(root.getPropertyValue("--primary")).toBe(phosphor.tokens["--primary"]);
    expect(root.getPropertyValue("--background")).toBe(
      phosphor.tokens["--background"]
    );
  });

  it("leaves no token from the previous theme behind", () => {
    applyTheme("phosphor");
    applyTheme("ember");
    const root = document.documentElement.style;
    for (const [token, value] of Object.entries(themeById("ember").tokens)) {
      expect(root.getPropertyValue(token), token).toBe(value);
    }
  });

  it("rejects an unknown id so a stale stored theme falls back", () => {
    expect(isThemeId("ember")).toBe(true);
    expect(isThemeId("solarized")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(themeById(DEFAULT_THEME).id).toBe("ember");
  });
});
