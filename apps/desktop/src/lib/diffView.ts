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
import type {
  FileDiffContentsLoader,
  FileDiffOptions,
  FileDiffLoadedFiles,
} from "@pierre/diffs";

registerCustomTheme("vesper", () => import("@shikijs/themes/vesper"));

/** One shared base option object — identity-stable so a re-render never
 *  restarts the underlying FileDiff for want of an option comparison. */
const baseTurnDiffOptions: FileDiffOptions<undefined, undefined> = {
  theme: "vesper",
  diffStyle: "unified",
  diffIndicators: "bars",
  hunkSeparators: "line-info",
  lineDiffType: "word",
  overflow: "wrap",
  // The panel header already names the file; pierre's default header would
  // say it a second time.
  disableFileHeader: true,
};

/**
 * Options for one turn diff, with context expansion: the loader hands pierre
 * both sides' full contents (`checkpoint_turn_contents` through the query
 * cache), so a hunk separator grows past the patch's 3-line context.
 */
export const buildTurnDiffOptions = (load: FileDiffContentsLoader) => ({
  ...baseTurnDiffOptions,
  expandUnchanged: true,
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
