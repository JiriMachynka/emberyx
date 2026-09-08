import { describe, expect, it } from "vitest";
import {
  fileHunkCount,
  fileHunkPatch,
  splitFilePatches,
} from "@/lib/patchFiles";

const TWO_FILES = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,3 +10,3 @@
 ten
-eleven
+ELEVEN
 twelve
diff --git a/dir/b.ts b/dir/b.ts
index 333..444 100644
--- a/dir/b.ts
+++ b/dir/b.ts
@@ -1,2 +1,2 @@
-const a = 1
+const a = 2
 export {}
`;

describe("splitFilePatches", () => {
  it("splits a multi-file patch by file and names the post-image path", () => {
    const files = splitFilePatches(TWO_FILES);
    expect(files.map((f) => f.path)).toEqual(["a.txt", "dir/b.ts"]);
    expect(files[0].patch.startsWith("diff --git a/a.txt")).toBe(true);
  });

  it("names a deleted file by its pre-image, since the post-image is /dev/null", () => {
    const deletion = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
    expect(splitFilePatches(deletion)[0].path).toBe("gone.txt");
  });

  it("ignores anything before the first file header", () => {
    expect(splitFilePatches("warning: noise\n").length).toBe(0);
  });
});

describe("fileHunkPatch", () => {
  it("keeps the file headers so git apply knows what it is patching", () => {
    // `--- / +++` is the whole header git apply needs; the `diff --git` line is
    // dropped, matching what the panel already fed it one file at a time.
    const patch = fileHunkPatch(TWO_FILES, "a.txt", 0);
    expect(patch).toContain("--- a/a.txt");
    expect(patch).toContain("+++ b/a.txt");
  });

  it("takes the requested hunk and no other", () => {
    const first = fileHunkPatch(TWO_FILES, "a.txt", 0) ?? "";
    expect(first).toContain("+TWO");
    expect(first).not.toContain("+ELEVEN");

    const second = fileHunkPatch(TWO_FILES, "a.txt", 1) ?? "";
    expect(second).toContain("+ELEVEN");
    expect(second).not.toContain("+TWO");
  });

  it("does not bleed into the next file", () => {
    const last = fileHunkPatch(TWO_FILES, "dir/b.ts", 0) ?? "";
    expect(last).toContain("const a = 2");
    expect(last).not.toContain("a.txt");
  });

  it("ends with a newline, which git apply requires", () => {
    expect(fileHunkPatch(TWO_FILES, "dir/b.ts", 0)?.endsWith("\n")).toBe(true);
  });

  it("returns null rather than the wrong hunk when the index is stale", () => {
    expect(fileHunkPatch(TWO_FILES, "a.txt", 5)).toBeNull();
    expect(fileHunkPatch(TWO_FILES, "nope.txt", 0)).toBeNull();
  });
});

describe("fileHunkCount", () => {
  it("counts hunks per file", () => {
    expect(fileHunkCount(TWO_FILES, "a.txt")).toBe(2);
    expect(fileHunkCount(TWO_FILES, "dir/b.ts")).toBe(1);
    expect(fileHunkCount(TWO_FILES, "missing")).toBe(0);
  });
});
