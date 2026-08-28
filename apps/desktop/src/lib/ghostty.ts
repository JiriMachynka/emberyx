/**
 * Ghostty's VT engine, compiled to WebAssembly, as the terminal's screen model.
 *
 * The pane used to render PTY output as coloured lines, which has no cursor and
 * no grid: a prompt that redraws itself (Powerlevel10k's instant prompt) landed
 * twice, and anything full-screen — vim, htop, less — was unreadable. A real VT
 * interprets the escape sequences instead of printing past them.
 *
 * Loaded on demand, not at startup: the package carries its wasm inline, which
 * is ~650kB of base64 nobody who never opens a terminal should pay for.
 */
import type { FitAddon, ITheme, Terminal } from "ghostty-web";

export interface GhosttyModule {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let loading: Promise<GhosttyModule> | null = null;

/** Load the VT wasm and its renderer, at most once per window. */
export const loadGhostty = (): Promise<GhosttyModule> => {
  loading ??= import("ghostty-web").then(async (mod) => {
    await mod.init();
    return { Terminal: mod.Terminal, FitAddon: mod.FitAddon };
  });
  return loading;
};

/** Read a CSS custom property off the document, for the terminal theme. */
const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value.length > 0 ? value : fallback;
};

/**
 * The app's own surface colours, so the grid doesn't sit on a foreign black.
 * ANSI 0-15 stay at Ghostty's defaults — those belong to the programs running
 * in the terminal, not to the app's palette.
 */
export const terminalTheme = (): ITheme => ({
  background: cssVar("--canvas", "#0a0a0a"),
  foreground: cssVar("--foreground", "#e5e5e5"),
  cursor: cssVar("--ring", "#e08a3c"),
  selectionBackground: "rgba(224, 138, 60, 0.28)",
});
