/**
 * The SnapShots accessibility tree, formatted for two readers: the agent (a
 * text block that rides next to the image on send) and the lightbox (the
 * compact tree under the picture). Pure — the Rust side walks the real
 * AXUIElement tree; this only shapes what arrived.
 */

/** One node of the tree the Rust walk produced; bounds in window space. */
export interface SnapshotA11yNode {
  role: string;
  name?: string | null;
  value?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  children?: SnapshotA11yNode[];
}

/** What the `snapshot-captured` event (and the `snapshots_capture` command)
 *  carries. `error` replaces the image when a permission is missing. */
export interface SnapshotCaptured {
  png?: string | null;
  app: string;
  title: string;
  a11y?: SnapshotA11yNode | null;
  error?: string | null;
}

/** Mirrors the Rust walk's caps, so a payload that skipped them still renders
 *  bounded — a huge tree must not flood either reader. */
export const MAX_DEPTH = 4;
export const MAX_NODES = 200;

const describe = (node: SnapshotA11yNode): string => {
  const name = node.name ? ` "${node.name}"` : "";
  const value = node.value ? ` = ${node.value}` : "";
  return `${node.role}${name}${value} ${node.x},${node.y} ${node.w}x${node.h}`;
};

/** Indented tree: `role "name" x,y w×h`, two spaces per level. Stops at the
 *  depth and node caps (with a `…` marker when nodes were cut) and returns ""
 *  for an absent tree. */
export const formatA11yTree = (
  root?: SnapshotA11yNode | null
): string => {
  if (!root) return "";
  const lines: string[] = [];
  let nodes = 0;
  let truncated = false;
  const visit = (node: SnapshotA11yNode, level: number) => {
    if (truncated || level > MAX_DEPTH) return;
    if (nodes >= MAX_NODES) {
      truncated = true;
      return;
    }
    nodes += 1;
    lines.push(`${"  ".repeat(level - 1)}${describe(node)}`);
    for (const child of node.children ?? []) visit(child, level + 1);
  };
  visit(root, 1);
  if (truncated) lines.push("…");
  return lines.join("\n");
};

/** The text block the agent receives beside a snapshot image. The header
 *  always names what was captured; the tree follows when there is one. */
export const snapshotTextBlock = (snapshot: {
  app: string;
  title: string;
  a11y?: string;
}): string => {
  const header = `[Snapshot — ${snapshot.app}${snapshot.title ? `: ${snapshot.title}` : ""}]`;
  return snapshot.a11y ? `${header}\n${snapshot.a11y}` : header;
};
