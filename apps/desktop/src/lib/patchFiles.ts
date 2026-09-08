/**
 * Cutting a whole-working-tree patch back down to one file, or one hunk.
 *
 * The changes panel renders every changed file as one patch, but staging and
 * discarding act on a single hunk. @pierre/diffs exposes hunk metadata and can
 * resolve a hunk visually (`diffAcceptRejectHunk`), but it never emits patch
 * text — so the text is cut out of the raw patch here and handed to
 * `git apply` unchanged. Splitting a patch git produced beats re-rendering one
 * from a parsed model: the first applies, the second only usually does.
 *
 * Per-file hunk parsing is `lib/hunks.ts`; this module only adds the multi-file
 * split it never needed when a diff was fetched one file at a time.
 */

import { hunkPatch, parseDiff } from "@/lib/hunks";

/** `diff --git` starts a file; git never indents it. */
const FILE_BREAK = /(?=^diff --git )/m;

export interface FilePatch {
  /** Post-image path, i.e. what the file is called now. */
  path: string;
  /** The file's own patch, headers included. */
  patch: string;
}

/** The `+++ b/<path>` line names the file after the change; fall back to the
 *  pre-image for a deletion, where the post-image is `/dev/null`. */
const pathOf = (filePatch: string): string => {
  for (const line of filePatch.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trim();
      if (name !== "/dev/null") return name.replace(/^b\//, "");
    }
    if (line.startsWith("--- ")) {
      const name = line.slice(4).trim();
      if (name !== "/dev/null") return name.replace(/^a\//, "");
    }
  }
  const header = filePatch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  return header?.[2] ?? header?.[1] ?? "";
};

/** Split a multi-file patch into one entry per file. */
export const splitFilePatches = (patch: string): FilePatch[] =>
  patch
    .split(FILE_BREAK)
    .filter((part) => part.startsWith("diff --git "))
    .map((part) => ({ path: pathOf(part), patch: part }));

/**
 * One hunk of one file, as a patch git will apply. Returns null when the file
 * or hunk isn't in the patch — a stale index after the tree moved under us,
 * which must not silently apply the wrong hunk.
 */
export const fileHunkPatch = (
  patch: string,
  file: string,
  hunkIndex: number
): string | null => {
  const target = splitFilePatches(patch).find((f) => f.path === file);
  if (!target) return null;
  const parsed = parseDiff(target.patch);
  const hunk = parsed.hunks[hunkIndex];
  if (!hunk) return null;
  return hunkPatch(parsed, hunk, file);
};

/** How many hunks a file has in this patch. */
export const fileHunkCount = (patch: string, file: string): number => {
  const target = splitFilePatches(patch).find((f) => f.path === file);
  return target ? parseDiff(target.patch).hunks.length : 0;
};
