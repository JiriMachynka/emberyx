/**
 * The @pierre/diffs surface as Emberyx renders it.
 *
 * pierre injects its own shadow styles; what this module adds is the Shiki
 * theme registration (Vesper, the same theme the chat's code blocks use) and
 * the option set the turn-review diff renders with. The chrome colors come
 * from the `.pierre-diffs` CSS variable bridge in index.css — token colors
 * from Shiki, panel colors from Emberyx.
 */

import { registerCustomTheme } from "@pierre/diffs";
import type { FileDiffContentsLoader, FileDiffLoadedFiles } from "@pierre/diffs";
import type { ThemeRegistrationAny } from "shiki/core";

/**
 * Vesper is tuned for its own #101010 canvas; the app renders it on a
 * grey surface instead. Registered as-is it painted a darker slab inside
 * the code box and left its dim greys under-contrasted. The patch keeps
 * every hue — it lifts the two neutral greys so the quiet hierarchy
 * (comment < keyword < plain) survives the lighter background, and hands
 * the background to the box itself.
 */
export const themeForSurface = (theme: ThemeRegistrationAny): ThemeRegistrationAny => {
  const lift: Record<string, string> = {
    "#8b8b8b94": "#8f8f8f",
    "#a0a0a0": "#b0b0b0",
  };
  const lifted = (foreground: string | undefined): string | undefined => {
    if (!foreground) return undefined;
    return lift[foreground.toLowerCase()] ?? foreground;
  };
  return {
    ...theme,
    colors: { ...theme.colors, "editor.background": "transparent" },
    tokenColors: (theme.tokenColors ?? []).map((rule) =>
      typeof rule === "object" && rule.settings
        ? { ...rule, settings: { ...rule.settings, foreground: lifted(rule.settings.foreground) } }
        : rule
    ),
  };
};

registerCustomTheme("vesper", async () => {
  const { default: theme } = await import("@shikijs/themes/vesper");
  return { default: themeForSurface(theme) };
});

/**
 * Pierre paints tokens with `light-dark(--token-light, --token-dark)`. A
 * single `"vesper"` string only fills the dark slot, so a Mac in light
 * appearance (dark app, light OS) inherits one color and the highlighter
 * looks like it never ran. Both slots are Vesper: the app is dark either way.
 */
export const DIFF_THEME = { dark: "vesper", light: "vesper" } as const;

/**
 * Options for the working-tree surface: every changed file in one scroll, so
 * unlike the turn review this one keeps pierre's own file headers and sticks
 * them while a long file scrolls past. `line-info-basic` is the collapsed
 * "N unmodified lines" band between hunks.
 *
 * Written out as a plain literal rather than typed `FileDiffOptions`: that
 * annotation carries optional line-event callbacks whose props are narrower
 * than CodeView's own.
 */
export const workingDiffOptions = {
  theme: DIFF_THEME,
  diffStyle: "unified" as const,
  diffIndicators: "bars" as const,
  overflow: "wrap" as const,
  hunkSeparators: "line-info-basic" as const,
  lineDiffType: "word-alt" as const,
  // CodeView's own option, not a per-file diff option: it sticks whichever
  // file header is at the top of the scroll.
  stickyHeaders: true,
};

/**
 * The turn review renders like the working tree — every file the turn changed
 * in one scroll, with pierre's own sticky file headers — plus the contents
 * loader, so a "N unmodified lines" band can expand past the patch's context.
 *
 * Deliberately **not** `expandUnchanged`: that renders every line of every
 * file, and on a multi-file patch it also pulls both sides of each file
 * through the loader at once. One file's review could afford it; a whole
 * turn's froze the app. The bands stay collapsed and expand on click.
 */
export const buildTurnReviewOptions = (load: FileDiffContentsLoader) => ({
  ...workingDiffOptions,
  loadDiffFiles: load,
});

/** Adapt the Rust contents pair to pierre's loader shape. An absent old side
 *  (file created in the range) reads as a pure rename to pierre, which skips
 *  the loader for added/deleted diffs anyway. */
export const contentsToLoader =
  (
    fetch: (file: string) => Promise<{
      oldText: string | null;
      newText: string | null;
    }>
  ): FileDiffContentsLoader =>
  async (fileDiff) => {
    const contents = await fetch(fileDiff.name);
    const loaded: FileDiffLoadedFiles =
      contents.oldText == null
        ? { oldFile: null, newFile: { name: fileDiff.name, contents: contents.newText ?? "" } }
        : {
            oldFile: { name: fileDiff.name, contents: contents.oldText },
            newFile: { name: fileDiff.name, contents: contents.newText ?? "" },
          };
    return loaded;
  };
