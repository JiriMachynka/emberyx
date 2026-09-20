import { memo, useMemo, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";

import { FileTypeIcon } from "@/components/FileTypeIcon";
import { useProjectCwd } from "@/components/FileRef";
import { fileEditsFor, pathsForActivity } from "@/lib/activityDisplay";
import { buildTree } from "@/lib/fileTree";
import { absolutePath, relativeToProject } from "@/lib/fileRef";
import { langFromPath } from "@/lib/highlight";
import { requestOpenFile } from "@/lib/openFileRequest";
import { cn } from "@/lib/utils";
import { Disclosure, DisclosureChevron } from "@/components/chat/Disclosure";
import { ToolBody } from "@/components/chat/ToolViews";
import type { ActivityFileEdit, ActivityItem } from "@/types";

/** What one file in the tree knows: its exact change state, the code the edit
 *  moved, and whether that change is still in flight. */
type FileEditRow = Omit<ActivityFileEdit, "state"> & {
  /** Null for a change whose tool input has not named it yet. */
  state: ActivityFileEdit["state"] | null;
  live: boolean;
};

const STATE: Record<
  NonNullable<ActivityFileEdit["state"]>,
  { label: string; className: string; doing: string }
> = {
  created: { label: "created", className: "text-emerald-400/90", doing: "creating" },
  modified: { label: "modified", className: "text-primary", doing: "modifying" },
  deleted: { label: "deleted", className: "text-red-400", doing: "deleting" },
};

/**
 * Consecutive file reads/edits as a folder tree, the way T3 shows them in
 * chat — same folding and expand/collapse as the Files dock. Each change row
 * names its exact state, and while the turn is live the modified code opens
 * under it; when the turn settles the tree reads as one compact list again,
 * and a reader can always reopen a diff with its chevron. Clicking a file
 * opens it in the editor.
 */
export function ActivityFileTree({
  activities,
  live,
}: {
  activities: ActivityItem[];
  /** Live turn: the newest edit's diff follows the work and every diff folds
   *  when the turn does. A replayed transcript has nothing running, so its
   *  rows stay user-controlled from the start. */
  live?: boolean;
}) {
  const cwd = useProjectCwd();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const perPath = useMemo(() => {
    const liveFiles = new Set<string>();
    const failedFiles = new Set<string>();
    const edits = new Map<string, Omit<FileEditRow, "live">>();
    const seen = new Set<string>();
    const files: { path: string; status: string }[] = [];
    for (const activity of activities) {
      // A change verb per path supersedes whatever an earlier edit said.
      if (activity.kind === "fileChange") {
        for (const [raw, edit] of fileEditsFor(activity)) {
          const rel = cwd ? relativeToProject(raw, cwd) : raw.replace(/\\/g, "/");
          if (!rel) continue;
          const state =
            edits.has(rel) && edit.state === "created"
              ? // A second write to the same path is an overwrite.
                ("modified" as const)
              : edit.state;
          edits.set(rel, { state, before: edit.before, after: edit.after });
        }
      }
      for (const raw of pathsForActivity(activity)) {
        const path = cwd ? relativeToProject(raw, cwd) : raw.replace(/\\/g, "/");
        if (!path) continue;
        if (!activity.complete) liveFiles.add(path);
        if (activity.failed) failedFiles.add(path);
        if (seen.has(path)) continue;
        seen.add(path);
        files.push({ path, status: "  " });
      }
    }
    return { edits, liveFiles, failedFiles, rows: buildTree(files) };
  }, [activities, cwd]);

  // The newest change in the stream is the one the turn is still "doing" —
  // its diff is what opens for the turn's reader.
  const latestEditPath = useMemo(() => {
    for (let i = activities.length - 1; i >= 0; i -= 1) {
      const activity = activities[i];
      if (activity.kind !== "fileChange") continue;
      for (const raw of fileEditsFor(activity).keys()) {
        const path = cwd ? relativeToProject(raw, cwd) : raw;
        if (path) return path;
      }
    }
    return null;
  }, [activities, cwd]);

  const shown = useMemo(() => {
    if (collapsed.size === 0) return perPath.rows;
    const dirs = [...collapsed];
    return perPath.rows.filter(
      (row) => !dirs.some((dir) => row.path !== dir && row.path.startsWith(`${dir}/`))
    );
  }, [perPath.rows, collapsed]);

  if (perPath.rows.length === 0) return null;

  const openFile = (path: string) => {
    if (!cwd) return;
    requestOpenFile(path.startsWith("/") ? path : absolutePath(path, cwd));
  };

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  return (
    <div className="py-1 text-xs">
      {shown.map((row) => {
        const indent = { paddingLeft: 12 + row.depth * 12 };
        if (row.kind === "dir") {
          const closed = collapsed.has(row.path);
          return (
            <button
              key={`dir:${row.path}`}
              type="button"
              style={indent}
              onClick={() => toggleDir(row.path)}
              className="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left text-muted-foreground transition-colors hover:text-foreground"
            >
              {closed ? (
                <ChevronRight className="size-3 shrink-0 opacity-60" />
              ) : (
                <ChevronDown className="size-3 shrink-0 opacity-60" />
              )}
              {closed ? (
                <Folder className="size-3.5 shrink-0" />
              ) : (
                <FolderOpen className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{row.name}</span>
            </button>
          );
        }
        const editInfo = perPath.edits.get(row.path);
        return (
          <FileTreeFile
            key={`file:${row.path}`}
            path={row.path}
            name={row.name}
            indent={indent}
            edit={editInfo ? { ...editInfo, live: perPath.liveFiles.has(row.path) } : null}
            failed={perPath.failedFiles.has(row.path)}
            autoOpen={live === true && row.path === latestEditPath}
            onOpenFile={() => openFile(row.path)}
          />
        );
      })}
    </div>
  );
}

/** One file row: its state word, an auto-followed (re)openable diff, click to
 *  edit. The auto state follows `autoOpen`; any chevron click makes this row
 *  user-owned for the turn, so folding the card never fights a reader. */
const FileTreeFile = memo(function FileTreeFile({
  path,
  name,
  indent,
  edit,
  failed,
  autoOpen,
  onOpenFile,
}: {
  path: string;
  name: string;
  indent: CSSProperties;
  edit: FileEditRow | null;
  failed: boolean;
  autoOpen: boolean;
  onOpenFile: () => void;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [bodyMounted, setBodyMounted] = useState(false);
  const live = edit?.live ?? false;
  const open = userOpen ?? (edit != null && autoOpen);
  if (open && edit && !bodyMounted) setBodyMounted(true);
  // One-sided is enough: a Write is all additions, a delete all removals.
  // Failed work, and a path with no text yet, stay a header.
  const before = edit?.before ?? "";
  const after = edit?.after ?? "";
  const diff =
    edit && !failed && (before.length > 0 || after.length > 0)
      ? { before, after }
      : null;

  return (
    <div className="relative">
      <div
        style={indent}
        className="flex w-full items-center gap-1.5 py-0.5 pr-3 text-left"
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-foreground"
          onClick={onOpenFile}
        >
          <FileTypeIcon path={path} />
          <span
            className={cn(
              "truncate",
              failed && "text-red-400",
              live && "tool-running-label"
            )}
          >
            {name}
          </span>
        </button>
        {edit?.state != null && (
          <span
            className={cn(
              "shrink-0 text-[0.65rem] leading-none",
              live && !failed
                ? "tool-running-label"
                : failed
                  ? "text-red-400"
                  : STATE[edit.state].className
            )}
          >
            {live && !failed
              ? STATE[edit.state].doing
              : failed
                ? "failed"
                : STATE[edit.state].label}
          </span>
        )}
        {diff && (
          <button
            type="button"
            onClick={() => {
              const next = userOpen ?? open;
              setUserOpen(!next);
              // Stay mounted while the collapse animates so it glides shut.
              setBodyMounted(true);
            }}
            aria-label={`Toggle modified code for ${name}`}
            className="shrink-0 text-muted-foreground outline-none transition-colors hover:text-foreground"
          >
            <DisclosureChevron open={open} />
          </button>
        )}
      </div>
      {diff && (
        <Disclosure open={open} onClosed={() => setBodyMounted(false)}>
          {bodyMounted && (
            <div
              style={{ paddingLeft: Number(indent.paddingLeft ?? 0) + 20 }}
              className="pr-4 pb-1.5"
            >
              <ToolBody
                part={{ kind: "diff", before: diff.before, after: diff.after, lang: langFromPath(path) }}
                streaming={live}
              />
            </div>
          )}
        </Disclosure>
      )}
    </div>
  );
});
