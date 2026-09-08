/**
 * The changes panel's file tree: a flat list of changed paths folded into
 * directories. Pure, so the panel can render it and a test can check the
 * folding without a DOM.
 */

export interface TreeFile {
  kind: "file";
  /** Full repo-relative path — the id the diff surface scrolls to. */
  path: string;
  /** Last segment, which is what the row shows. */
  name: string;
  depth: number;
  /** Single-letter git status: A, M, D, R. */
  badge: string;
}

export interface TreeDir {
  kind: "dir";
  /** Full path of the directory, unique among rows. */
  path: string;
  /** Segment(s) shown on the row — joined when a chain has one child. */
  name: string;
  depth: number;
}

export type TreeRow = TreeFile | TreeDir;

/** Porcelain's two-char status collapsed to the single letter the row shows.
 *  Index status wins when both halves changed, because that is the side a
 *  staged-scope tree is describing. */
export const statusBadge = (status: string): string => {
  if (status === "??") return "A";
  const index = status[0] ?? " ";
  const tree = status[1] ?? " ";
  const letter = index !== " " && index !== "?" ? index : tree;
  return letter === " " || letter === "?" ? "M" : letter;
};

/**
 * Fold paths into directory + file rows, depth-first, directories before files
 * at each level and each group sorted by name. A directory chain with a single
 * child is joined into one row (`apps/desktop/src`) — a column of one-child
 * folders is all indentation and no information.
 */
export const buildTree = (
  files: { path: string; status: string }[]
): TreeRow[] => {
  interface Node {
    dirs: Map<string, Node>;
    files: { path: string; status: string }[];
  }
  const root: Node = { dirs: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ path: file.path, status: file.status });
  }

  const rows: TreeRow[] = [];
  const walk = (node: Node, prefix: string, label: string, depth: number) => {
    // Join a chain that only ever has one child and no files of its own.
    let current = node;
    let joined = label;
    let path = prefix;
    while (current.files.length === 0 && current.dirs.size === 1) {
      const [only, child] = [...current.dirs][0];
      joined = joined ? `${joined}/${only}` : only;
      path = path ? `${path}/${only}` : only;
      current = child;
    }
    if (joined) {
      rows.push({ kind: "dir", path, name: joined, depth });
    }
    const childDepth = joined ? depth + 1 : depth;
    for (const name of [...current.dirs.keys()].sort()) {
      walk(
        current.dirs.get(name)!,
        path ? `${path}/${name}` : name,
        name,
        childDepth
      );
    }
    for (const file of [...current.files].sort((a, b) =>
      a.path.localeCompare(b.path)
    )) {
      rows.push({
        kind: "file",
        path: file.path,
        name: file.path.split("/").pop() ?? file.path,
        depth: childDepth,
        badge: statusBadge(file.status),
      });
    }
  };
  walk(root, "", "", 0);
  return rows;
};
