/**
 * Window translucency. 100 is the solid look the rest of Appearance paints;
 * anything lower mixes the chrome so the desktop shows through (macOS
 * vibrancy). Cards and popovers stay opaque so copy stays readable.
 */
import { isTauri } from "@tauri-apps/api/core";
import { themeById, type ThemeId } from "@/lib/themes";

// Below this the chrome text washes out on a bright wallpaper.
export const WINDOW_OPACITY_MIN = 50;
export const WINDOW_OPACITY_MAX = 100;
const WINDOW_OPACITY_STEP = 10;

/** The choices Appearance offers, solid first. */
export const WINDOW_OPACITY_OPTIONS = Array.from(
  { length: (WINDOW_OPACITY_MAX - WINDOW_OPACITY_MIN) / WINDOW_OPACITY_STEP + 1 },
  (_, i) => WINDOW_OPACITY_MAX - i * WINDOW_OPACITY_STEP
);

const TRANSLUCENT = [
  "--background",
  "--sidebar",
  "--canvas",
  "--chat-canvas",
] as const;

/** Snap to the nearest offered step, so an old free-form value still selects. */
export const clampWindowOpacity = (n: number): number =>
  Number.isFinite(n)
    ? Math.min(
        WINDOW_OPACITY_MAX,
        Math.max(
          WINDOW_OPACITY_MIN,
          Math.round(n / WINDOW_OPACITY_STEP) * WINDOW_OPACITY_STEP
        )
      )
    : WINDOW_OPACITY_MAX;

const withAlpha = (color: string, opacity: number): string => {
  if (opacity >= 1) return color;
  if (color.includes(" / ")) return color.replace(/\/ [^)]+\)$/, `/ ${opacity})`);
  return color.replace(/\)$/, ` / ${opacity})`);
};

// A missing capability or `macOSPrivateApi` flag must reject loudly: swallowing
// it leaves translucent tokens over a window with no blur behind them.
const syncWindowEffects = async (opacity: number, wallpaper: boolean) => {
  if (!isTauri()) return;
  const { Effect, getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  // A background image replaces the desktop, so there is nothing to blur.
  if (opacity >= 1 || wallpaper) await win.clearEffects();
  else await win.setEffects({ effects: [Effect.HudWindow] });
};

/** Paint chrome tokens at `percent` and ask the native window to match. */
export const applyWindowOpacity = (
  percent: number,
  themeId: ThemeId,
  wallpaper = false
) => {
  const opacity = clampWindowOpacity(percent) / 100;
  const root = document.documentElement.style;
  root.setProperty("--window-opacity", String(opacity));
  const theme = themeById(themeId);
  for (const token of TRANSLUCENT) {
    const base = theme.tokens[token];
    root.setProperty(token, withAlpha(base, opacity));
  }
  void syncWindowEffects(opacity, wallpaper);
};
