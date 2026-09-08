/**
 * The file tree as a flat row list.
 *
 * The tree used to be a recursive component that mounted every child of every
 * expanded directory. One `node_modules` is tens of thousands of DOM nodes, so
 * the shape it renders is a list now — flattened here, virtualized by the
 * component — and this stays pure so the flattening is testable on its own.
 */

import type { DirEntry } from "@/types";

export interface DirRow {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  /** Directories only; a file is never open. */
  open: boolean;
}

/** Rows for `root` and everything under its expanded directories, in the order
 *  `list_dir` returned them. A directory whose listing hasn't arrived yet
 *  contributes only its own row. */
export const buildDirRows = (
  root: string,
  name: string,
  open: ReadonlySet<string>,
  entries: ReadonlyMap<string, DirEntry[]>
): DirRow[] => {
  const rows: DirRow[] = [];
  const walk = (path: string, label: string, depth: number) => {
    const isOpen = open.has(path);
    rows.push({ path, name: label, depth, isDir: true, open: isOpen });
    if (!isOpen) return;
    for (const entry of entries.get(path) ?? []) {
      if (entry.isDir) walk(entry.path, entry.name, depth + 1);
      else
        rows.push({
          path: entry.path,
          name: entry.name,
          depth: depth + 1,
          isDir: false,
          open: false,
        });
    }
  };
  walk(root, name, 0);
  return rows;
};

/** Every directory between `root` and `file`, so opening a file from the chat
 *  or the finder unfolds the chain that reveals it. Returns the same set when
 *  nothing was added — the tree re-renders on identity. */
export const openToward = (
  open: ReadonlySet<string>,
  root: string,
  file: string
): ReadonlySet<string> => {
  if (!file.startsWith(`${root}/`)) return open;
  const segments = file.slice(root.length + 1).split("/");
  let added = false;
  const next = new Set(open);
  let path = root;
  // The last segment is the file itself, which opens nothing.
  for (const segment of segments.slice(0, -1)) {
    path = `${path}/${segment}`;
    if (!next.has(path)) {
      next.add(path);
      added = true;
    }
  }
  return added ? next : open;
};
