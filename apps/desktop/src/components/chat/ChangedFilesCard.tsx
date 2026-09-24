import { memo, useState } from "react";
import { ChevronDown, ChevronRight, FileDiff, Folder } from "lucide-react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { sumRangeFiles } from "@/lib/checkpoints";
import { useTurnFiles } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import { buildTree, dirTotals } from "@/lib/fileTree";

/** The file delta one settled turn produced, from the snapshot taken before it
 *  to its settle snapshot (or the next turn's — the Rust side resolves it).
 *  The full diff lives in the dock's diff tab; this card is the doorway to it,
 *  the way Waku scopes Review to a turn. Directories start folded — the card
 *  opens as one summary row per tree, not a wall of paths. */
export const ChangedFilesCard = memo(function ChangedFilesCard({
  projectPath,
  threadId,
  fromId,
  openEnded,
  review,
}: {
  projectPath: string;
  threadId: string;
  fromId: string;
  /** The newest turn's range ends at the working tree, so it alone re-reads. */
  openEnded: boolean;
  /** Jev scored this delta as worth a look. */
  review?: boolean;
}) {
  const { data: files } = useTurnFiles(projectPath, threadId, fromId, true, openEnded);
  // Null until the user folds or unfolds something — the default (everything
  // folded) is recomputed from the tree each render, so a refetch of the
  // newest turn's delta can't resurrect rows the user hasn't ruled on, and
  // their explicit toggles survive one.
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const requestTurnReview = useAgentStore((s) => s.requestTurnReview);
  if (!files || files.length === 0) return null;
  const { additions, deletions } = sumRangeFiles(files);
  const tree = buildTree(
    files.map((file) => ({ path: file.path, status: "  " }))
  );
  const dirPaths = tree.filter((row) => row.kind === "dir").map((row) => row.path);
  const folded = collapsed ?? new Set(dirPaths);
  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev ?? dirPaths);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };
  const shown =
    folded.size === 0
      ? tree
      : tree.filter(
          (row) =>
            ![...folded].some(
              (dir) => row.path !== dir && row.path.startsWith(`${dir}/`)
            )
        );
  const totals = dirTotals(files);
  return (
    <div className="chat-work-panel overflow-hidden rounded-xl border">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <FileDiff className="size-4 flex-none shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-medium">
            <span className="tabular-nums">
              {files.length === 1 ? "Changed 1 file" : `Changed ${files.length} files`}
            </span>
          </span>
          {review && (
            <span className="shrink-0 text-xs text-amber-400" title="Jev flagged auth, secrets, or a hard-to-undo change">
              review
            </span>
          )}
          <span className="flex flex-none gap-2 text-xs tabular-nums">
            <span className="text-emerald-400">+{additions}</span>
            <span className="text-red-400">−{deletions}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => requestTurnReview({ projectPath, threadId, fromId })}
          className="flex flex-none items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition active:scale-[0.97] hover:bg-muted/50 hover:text-foreground"
        >
          <FileDiff className="size-3.5" />
          Review
        </button>
      </div>
      <div className="flex flex-col border-t border-border py-1">
        {shown.map((row) => {
          const file = row.kind === "file" ? files.find((f) => f.path === row.path) : undefined;
          const indent = { paddingLeft: 12 + row.depth * 12 };
          if (row.kind === "dir") {
            const closed = folded.has(row.path);
            const total = totals.get(row.path);
            return (
              <button
                key={`dir:${row.path}`}
                type="button"
                style={indent}
                onClick={() => toggleDir(row.path)}
                title={closed ? `Show files in ${row.path}` : `Hide files in ${row.path}`}
                className="flex h-7 items-center gap-1.5 pr-3 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="flex size-3 shrink-0 items-center justify-center">
                  {closed ? (
                    <ChevronRight className="size-3 opacity-60" />
                  ) : (
                    <ChevronDown className="size-3 opacity-60" />
                  )}
                </span>
                <Folder className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {total?.counted && (
                  <span className="flex flex-none gap-2 tabular-nums">
                    <span className="text-emerald-400/80">+{total.additions}</span>
                    <span className="text-red-400/80">−{total.deletions}</span>
                  </span>
                )}
              </button>
            );
          }
          return (
            <div
              key={row.path}
              style={indent}
              className="flex h-7 items-center gap-1.5 pr-3 text-xs"
              title={row.path}
            >
              <span className="size-3 shrink-0" />
              <FileTypeIcon path={row.path} />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {file?.additions != null && (
                <span className="flex-none tabular-nums text-emerald-400">
                  +{file.additions}
                </span>
              )}
              {file?.deletions != null && (
                <span className="flex-none tabular-nums text-red-400">
                  −{file.deletions}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
