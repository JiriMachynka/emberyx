import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";

import { FileTypeIcon } from "@/components/FileTypeIcon";
import { useProjectCwd } from "@/components/FileRef";
import { pathsForActivity } from "@/lib/activityDisplay";
import { buildTree } from "@/lib/fileTree";
import { absolutePath, relativeToProject } from "@/lib/fileRef";
import { requestOpenFile } from "@/lib/openFileRequest";
import { cn } from "@/lib/utils";
import type { ActivityItem } from "@/types";

/**
 * Consecutive file reads/edits as a folder tree, the way T3 shows them in
 * chat — same folding and expand/collapse as the Files dock. Clicking a file
 * opens it in the editor.
 */
export function ActivityFileTree({ activities }: { activities: ActivityItem[] }) {
  const cwd = useProjectCwd();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { rows, running, failed } = useMemo(() => {
    const running = new Set<string>();
    const failed = new Set<string>();
    const seen = new Set<string>();
    const files: { path: string; status: string }[] = [];
    for (const activity of activities) {
      for (const raw of pathsForActivity(activity)) {
        const path = cwd ? relativeToProject(raw, cwd) : raw.replace(/\\/g, "/");
        if (!path) continue;
        if (!activity.complete) running.add(path);
        if (activity.failed) failed.add(path);
        if (seen.has(path)) continue;
        seen.add(path);
        files.push({ path, status: "  " });
      }
    }
    return { rows: buildTree(files), running, failed };
  }, [activities, cwd]);

  const shown = useMemo(() => {
    if (collapsed.size === 0) return rows;
    const dirs = [...collapsed];
    return rows.filter(
      (row) => !dirs.some((dir) => row.path !== dir && row.path.startsWith(`${dir}/`))
    );
  }, [rows, collapsed]);

  if (rows.length === 0) return null;

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
        const live = running.has(row.path);
        return (
          <button
            key={`file:${row.path}`}
            type="button"
            style={indent}
            onClick={() => openFile(row.path)}
            className={cn(
              "flex w-full items-center gap-1.5 py-0.5 pr-3 text-left transition-colors hover:text-foreground",
              failed.has(row.path) && "text-red-400",
              live && "tool-running-label"
            )}
          >
            <span className="size-3 shrink-0" />
            <FileTypeIcon path={row.path} />
            <span className="truncate">{row.name}</span>
          </button>
        );
      })}
    </div>
  );
}
