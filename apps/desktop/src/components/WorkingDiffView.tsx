import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { parsePatchFiles } from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContextProvider,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import { ChevronDown, ChevronRight, Minus, Plus, Undo2 } from "lucide-react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { workingDiffOptions } from "@/lib/diffView";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  diffHighlighterOptions,
  diffPoolOptions,
  workersFailed,
} from "@/lib/diffWorkers";
import { buildTree, type TreeRow } from "@/lib/fileTree";
import { cn } from "@/lib/utils";
import type { GitFile } from "@/types";

/** Per-hunk buttons ride on a line annotation, so pierre owns their placement
 *  inside the virtualized list. The metadata is what the renderer needs to know
 *  which hunk it is acting on. */
interface HunkAnchor {
  file: string;
  hunkIndex: number;
}

/** Above this many files the diff renders only the first slice and offers the
 *  rest behind a button. A 48-file working tree used to parse, tokenize and lay
 *  out every file at once — seconds of stall and over a gigabyte of renderer
 *  memory for a surface nobody reads top to bottom. */
const FILE_BUDGET = 10;

interface WorkingDiffViewProps {
  /** The whole scope as one multi-file patch. */
  patch: string;
  /** Status rows for the same scope — the tree's source, since a file can be
   *  listed with no textual diff (a mode change, a pure rename). */
  files: GitFile[];
  staged: boolean;
  /** False while the patch can't be applied back (a `-w` diff), so per-hunk
   *  buttons are hidden instead of failing on click. */
  hunkActions: boolean;
  /** Stage, unstage or discard a hunk. `patch` is the text the rendered hunks
   *  came from — the deferred one, whose indexes are what a click means.
   *  Absent in a read-only surface, where there is no index to move a hunk
   *  into. */
  onHunk?: (
    patch: string,
    file: string,
    hunkIndex: number,
    action: "stage" | "unstage" | "discard"
  ) => void;
  onFileAction?: (file: GitFile, action: "stage" | "unstage" | "discard") => void;
  /** Render options, when the surface needs its own — the turn review adds
   *  context expansion. Must be identity-stable, or the FileDiff restarts. */
  options?: typeof workingDiffOptions & {
    expandUnchanged?: boolean;
    loadDiffFiles?: FileDiffContentsLoader;
  };
  /** Namespaces pierre's parse cache, so two surfaces holding patches of the
   *  same length don't read each other's files. */
  cacheKey?: string;
}

export function WorkingDiffView({
  patch,
  files,
  staged,
  hunkActions,
  onHunk,
  onFileAction,
  options: optionsProp,
  cacheKey = "working",
}: WorkingDiffViewProps) {
  const view = useRef<CodeViewHandle<HunkAnchor, undefined>>(null);
  const pendingScroll = useRef<string | null>(null);
  // A dead worker pool falls back to main-thread highlighting rather than
  // rendering nothing; `getServerSnapshot` is the same getter because this app
  // never server-renders.
  const poolFailed = useSyncExternalStore(
    workersFailed.subscribe,
    workersFailed.get,
    workersFailed.get
  );
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** How many parsed files the CodeView is handed. Grows on "Show all". */
  const [budget, setBudget] = useState(FILE_BUDGET);

  // One parse per patch, and it is the expensive one — a wide working tree is
  // megabytes of text on the main thread. Deferred so a turn that rewrites the
  // patch mid-stream can't freeze the toolbar and the tree with it; the parse
  // itself still runs whole, this only stops it from blocking the interaction
  // that triggered it. Content-equal patches share a dep, so an invalidation
  // that fetched the same bytes re-parses nothing.
  const parsed = useDeferredValue(patch);
  const items = useMemo(() => {
    if (!parsed.trim()) return [];
    // Strict first, forgiving second: pierre throws on a hunk whose counts
    // don't match its body, and a patch cut at a byte budget ends inside one.
    // Throwing here happens during render, which takes the window down — a
    // last file rendered short is the better failure.
    let entries;
    try {
      entries = parsePatchFiles(parsed, `${cacheKey}:${parsed.length}`, true);
    } catch {
      entries = parsePatchFiles(parsed, `${cacheKey}:${parsed.length}:lax`, false);
    }
    return entries
      .flatMap((entry) => entry.files)
      .map((fileDiff) => ({
        id: fileDiff.name,
        type: "diff" as const,
        fileDiff,
        annotations: fileDiff.hunks.map((hunk, hunkIndex) => ({
          // A pure deletion hunk adds no lines, so anchor it on the side that
          // actually has one or the annotation lands nowhere.
          side: (hunk.additionCount > 0 ? "additions" : "deletions") as
            | "additions"
            | "deletions",
          lineNumber:
            hunk.additionCount > 0 ? hunk.additionStart : hunk.deletionStart,
          metadata: { file: fileDiff.name, hunkIndex },
        })),
      }));
  }, [parsed, cacheKey]);

  const capped = items.length > budget;
  const visibleItems = capped ? items.slice(0, budget) : items;

  // A new patch re-caps, so a reveal doesn't carry into the next diff.
  useEffect(() => {
    setBudget(FILE_BUDGET);
  }, [parsed]);

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const visible = query
      ? files.filter((f) => f.path.toLowerCase().includes(query))
      : files;
    return buildTree(visible);
  }, [files, filter]);

  // Hide rows inside a collapsed directory. Depth alone can't say it — the
  // check is whether any collapsed directory is a prefix of the row's path.
  const shown = useMemo(() => {
    if (collapsed.size === 0) return rows;
    // Spread once, not once per row.
    const dirs = [...collapsed];
    return rows.filter(
      (row) =>
        !dirs.some((dir) => row.path !== dir && row.path.startsWith(`${dir}/`))
    );
  }, [rows, collapsed]);

  const options = optionsProp ?? workingDiffOptions;

  // A file that scrolled out of the patch (staged, discarded) shouldn't leave
  // the tree pointing at nothing.
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (active && !items.some((item) => item.id === active)) setActive(null);
  }, [items, active]);

  // A file past the budget is revealed first, then scrolled to once pierre has
  // laid the new items out — two frames: React's commit, then pierre's.
  useEffect(() => {
    const path = pendingScroll.current;
    if (!path) return;
    pendingScroll.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        view.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
      })
    );
  }, [budget]);

  const revealAndScroll = (path: string) => {
    setActive(path);
    const index = items.findIndex((item) => item.id === path);
    if (index >= visibleItems.length) {
      pendingScroll.current = path;
      setBudget(items.length);
      return;
    }
    view.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
  };

  const runHunk = (anchor: HunkAnchor, action: "stage" | "unstage" | "discard") => {
    // Cut from the patch the rendered hunks came from — the deferred one, not
    // the newest. The index the user clicked only means anything in that text,
    // and the cut itself happens Rust-side, on the text git produced.
    onHunk?.(parsed, anchor.file, anchor.hunkIndex, action);
  };

  return (
    <WorkerPoolContextProvider
      poolOptions={diffPoolOptions}
      highlighterOptions={diffHighlighterOptions}
    >
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <CodeView<HunkAnchor, undefined>
          disableWorkerPool={poolFailed}
          // Same CSS variable bridge the turn review uses, or pierre renders
          // with its own chrome colors instead of the panel's.
          className="pierre-diffs min-h-0 flex-1 overflow-auto"
          items={visibleItems}
          options={options}
          ref={view}
          renderAnnotation={(annotation) => {
            const meta = annotation.metadata;
            if (!meta || !hunkActions || !onHunk) return null;
            return (
              <div className="flex items-center gap-1 px-2 py-0.5">
                {staged ? (
                  <HunkButton
                    title="Unstage this hunk"
                    onClick={() => runHunk(meta, "unstage")}
                  >
                    <Minus className="size-3" />
                    Unstage
                  </HunkButton>
                ) : (
                  <>
                    <HunkButton
                      title="Discard this hunk"
                      onClick={() => runHunk(meta, "discard")}
                    >
                      <Undo2 className="size-3" />
                      Discard
                    </HunkButton>
                    <HunkButton
                      title="Stage this hunk"
                      onClick={() => runHunk(meta, "stage")}
                    >
                      <Plus className="size-3" />
                      Stage
                    </HunkButton>
                  </>
                )}
              </div>
            );
          }}
        />
        {capped && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span>
              Showing {visibleItems.length} of {items.length} files.
            </span>
            <button
              type="button"
              onClick={() => setBudget(items.length)}
              className="rounded-md border px-2 py-0.5 text-foreground transition-colors hover:bg-accent"
            >
              Show all {items.length} files
            </button>
          </div>
        )}
      </div>

      <div className="flex w-64 shrink-0 flex-col border-l">
        <div className="shrink-0 p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            spellCheck={false}
            className="h-8 w-full rounded-lg bg-secondary px-2.5 text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto pb-2">
          {shown.map((row) => (
            <TreeRowView
              key={`${row.kind}:${row.path}`}
              row={row}
              active={row.kind === "file" && row.path === active}
              collapsed={collapsed.has(row.path)}
              onToggleDir={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(row.path)) next.add(row.path);
                  return next;
                })
              }
              onPick={() => revealAndScroll(row.path)}
              onAction={
                onFileAction &&
                ((action) => {
                  const file = files.find((f) => f.path === row.path);
                  if (file) onFileAction(file, action);
                })
              }
              staged={staged}
            />
          ))}
          {shown.length === 0 && (
            <p className="px-3 py-6 text-xs text-muted-foreground">
              {filter.trim() ? "Nothing matches." : "No changes."}
            </p>
          )}
        </div>
      </div>
    </div>
    </WorkerPoolContextProvider>
  );
}

function TreeRowView({
  row,
  active,
  collapsed,
  staged,
  onToggleDir,
  onPick,
  onAction,
}: {
  row: TreeRow;
  active: boolean;
  collapsed: boolean;
  staged: boolean;
  onToggleDir: () => void;
  onPick: () => void;
  /** Absent in a read-only surface — a turn's delta is history, not a work
   *  queue. */
  onAction?: (action: "stage" | "unstage" | "discard") => void;
}) {
  const indent = { paddingLeft: 8 + row.depth * 12 };

  if (row.kind === "dir") {
    return (
      <button
        onClick={onToggleDir}
        style={indent}
        className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{row.name}</span>
      </button>
    );
  }

  return (
    <div
      style={indent}
      className={cn(
        "group flex w-full items-center gap-1.5 py-1 pr-2 text-xs",
        active && "bg-secondary"
      )}
    >
      <button
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <FileTypeIcon path={row.path} />
        <span className="truncate">{row.name}</span>
      </button>
      {onAction && (
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {staged ? (
            <RowButton title="Unstage" onClick={() => onAction("unstage")}>
              <Minus className="size-3" />
            </RowButton>
          ) : (
            <>
              <RowButton title="Discard" onClick={() => onAction("discard")}>
                <Undo2 className="size-3" />
              </RowButton>
              <RowButton title="Stage" onClick={() => onAction("stage")}>
                <Plus className="size-3" />
              </RowButton>
            </>
          )}
        </div>
      )}
      <span
        className={cn(
          "shrink-0 rounded bg-secondary px-1 text-[10px] text-muted-foreground",
          onAction && "group-hover:hidden"
        )}
      >
        {row.badge}
      </span>
    </div>
  );
}

function HunkButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function RowButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}
