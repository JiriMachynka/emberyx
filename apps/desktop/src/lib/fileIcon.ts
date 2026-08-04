import { FILE_EXTENSIONS, FILE_NAMES, PATH_NAMES } from "@/lib/fileIconMap";

/** Name of the vendored Material icon for a file, e.g. "App.tsx" → "react_ts". */
export function fileIconName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "";

  // Longest directory suffix first, so ".config/foo" beats a bare extension.
  for (let i = 0; i < segments.length - 1; i++) {
    const suffix = segments.slice(i).join("/");
    const byPath = PATH_NAMES[suffix];
    if (byPath) return byPath;
  }

  const byName = FILE_NAMES[name];
  if (byName) return byName;

  // Walk inward so "foo.d.ts" resolves as "d.ts" before "ts".
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const byExt = FILE_EXTENSIONS[parts.slice(i).join(".")];
    if (byExt) return byExt;
  }

  return "file";
}
