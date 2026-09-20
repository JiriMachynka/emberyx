import { Suspense, lazy, useMemo, useState } from "react";
import { isStaged, isUnstaged } from "@/lib/gitStatus";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  FileDiff,
  RefreshCw,
  GitBranch,
  ChevronDown,
  Plus,
  Minus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { HunkBody } from "@/components/diff/HunkBody";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename } from "@/lib/path";
import { parseDiff, hunkPatch } from "@/lib/hunks";
import { highlightCached, langFromPath } from "@/lib/highlight";
import {
  gitStatusInterval,
  useGitChanges,
  useGitCommitDiff,
  useGitWorkingDiff,
  useInvalidateGit,
  useThreadCheckpoints,
  useTurnFiles,
  useTurnPatch,
  fetchTurnContents,
} from "@/lib/queries";
import {
  sumRangeFiles,
  turnRangesNewestFirst,
  type TurnRange,
} from "@/lib/checkpoints";
import { buildTurnReviewOptions, contentsToLoader } from "@/lib/diffView";
import { PANEL_REVIEW_WIDTH } from "@/lib/panels";
import type { CommitReviewRequest, TurnReviewRequest } from "@/lib/agentStore";
import type { GitFile } from "@/types";
// File history is a drill-down, not part of the changes list — and it carries
// its own diff rendering. Only a session that opens it pays for it.
const GitRewind = lazy(() =>
  import("@/components/GitRewind").then((m) => ({ default: m.GitRewind }))
);
import { SidePanel } from "@/components/SidePanel";
import { WorkingDiffView } from "@/components/WorkingDiffView";

/** Unified diff rendered hunk by hunk, each with its own apply actions. */
function UnifiedDiff({
  text,
  lang,
  file,
  actions,
}: {
  text: string;
  lang: string | null;
  file: string;
  /** Per-hunk buttons; omitted for views where applying makes no sense. */
  actions?: (patch: string) => React.ReactNode;
}) {
  const parsed = useMemo(() => parseDiff(text), [text]);

  if (!text.trim()) {
    return (
      <div className="p-3 text-xs text-muted-foreground">No diff to show.</div>
    );
  }
  // Untracked files and `git show` output have no @@ headers — render flat.
  if (parsed.hunks.length === 0) {
    return (
      <pre className="overflow-x-auto whitespace-pre py-1 font-mono text-xs leading-relaxed">
        <div className="w-max min-w-full">
          <HunkBody text={text} lang={lang} highlight={highlightCached} />
        </div>
      </pre>
    );
  }

  return (
    <div className="font-mono text-xs leading-relaxed">
      {parsed.hunks.map((hunk) => (
        <div key={hunk.offset}>
          <div className="flex items-center justify-between gap-2 border-y border-sky-500/20 bg-sky-500/10 py-0.5 pl-5 pr-2">
            <span className="truncate text-sky-400">{hunk.header}</span>
            {actions && (
              <span className="flex shrink-0 items-center gap-1">
                {actions(hunkPatch(parsed, hunk, file))}
              </span>
            )}
          </div>
          <pre className="overflow-x-auto whitespace-pre py-1">
            <div className="w-max min-w-full">
              <HunkBody
                text={hunk.text.slice(hunk.header.length + 1)}
                lang={lang}
                highlight={highlightCached}
              />
            </div>
          </pre>
        </div>
      ))}
    </div>
  );
}


interface ChangesPanelProps {
  projectPath: string;
  /** Hide whitespace-only changes in the working-tree diff. */
  ignoreWhitespace: boolean;
  /** A "review this turn" request from a transcript card: the panel shows that
   *  turn's file delta instead of the working tree. Null = working tree. */
  turnPick: TurnReviewRequest | null;
  onExitTurnPick: () => void;
  /** The dropdown aims the review at another of the thread's turns. */
  onPickTurn: (pick: TurnReviewRequest) => void;
  /** A file picked out of the git menu's commit history: the panel shows that
   *  commit's read-only diff instead of the working tree. */
  commitPick: CommitReviewRequest | null;
  onExitCommitPick: () => void;
  onClose: () => void;
  /** Render inside the surface panel rather than as its own right aside. */
  embedded?: boolean;
  /** This dock tab is the one on screen. A diff tab that is open but behind
   *  another tab stays mounted, and used to keep polling `git status` — with
   *  `refetchOnWindowFocus` that is a `git` process per alt-tab, for a panel
   *  nobody is looking at. */
  active?: boolean;
}

export function ChangesPanel({
  projectPath,
  ignoreWhitespace,
  turnPick,
  onExitTurnPick,
  onPickTurn,
  commitPick,
  onExitCommitPick,
  onClose,
  embedded,
  active = true,
}: ChangesPanelProps) {
  // The working-tree surface renders one scope as one patch, so staged and
  // unstaged are a toggle rather than two lists — a single patch can only
  // describe one side of the index.
  const [scope, setScope] = useState<"working" | "staged">("working");

  // The index is the source of truth: a file shows up under
  // "Staged" when its index column is dirty and under "Changes" when its
  // worktree column is, so partly-staged files appear in both.
  const gitQuery = useGitChanges(
    projectPath,
    active,
    gitStatusInterval("watch")
  );
  const gitFiles = useMemo(() => gitQuery.data ?? [], [gitQuery.data]);
  const stagedFiles = gitFiles.filter(isStaged);
  const unstagedFiles = gitFiles.filter(isUnstaged);

  const invalidateGit = useInvalidateGit();

  const commitDiffQuery = useGitCommitDiff(
    projectPath,
    commitPick?.sha ?? null,
    commitPick?.file ?? null
  );

  /** Run a git mutation, refresh every git view, and toast on failure. */
  async function run(fn: () => Promise<unknown>, what: string) {
    try {
      await fn();
      invalidateGit(projectPath);
    } catch (e) {
      toast.error(what, { description: String(e) });
    }
  }

  const stage = (files: string[]) =>
    run(() => invoke("git_stage", { path: projectPath, files }), "Couldn't stage");

  const unstage = (files: string[]) =>
    run(
      () => invoke("git_unstage", { path: projectPath, files }),
      "Couldn't unstage"
    );

  const applyHunk = (
    patch: string,
    file: string,
    hunkIndex: number,
    cached: boolean,
    reverse: boolean
  ) =>
    run(
      () =>
        invoke("git_apply_hunk", {
          path: projectPath,
          patch,
          file,
          hunkIndex,
          cached,
          reverse,
        }),
      "Couldn't apply hunk"
    );

  async function discardFile(file: GitFile) {
    const ok = await ask(
      file.untracked
        ? `Delete ${file.path}? This can't be undone.`
        : `Discard all changes to ${file.path}? This can't be undone.`,
      { title: "Discard changes", kind: "warning" }
    );
    if (!ok) return;
    await run(
      () =>
        invoke("git_discard", {
          path: projectPath,
          files: [file.path],
          untracked: file.untracked,
        }),
      "Couldn't discard"
    );
  }

  async function discardHunk(patch: string, file: string, hunkIndex: number) {
    const ok = await ask("Discard this hunk? This can't be undone.", {
      title: "Discard hunk",
      kind: "warning",
    });
    if (ok) await applyHunk(patch, file, hunkIndex, false, true);
  }

  const [historyFile, setHistoryFile] = useState<string | null>(null);

  const stageAll = () => stage(unstagedFiles.map((f) => f.path));
  const unstageAll = () => unstage(stagedFiles.map((f) => f.path));

  // One patch for the whole scope, which is what the diff surface renders.
  const workingDiff = useGitWorkingDiff(
    projectPath,
    scope === "staged",
    ignoreWhitespace,
    active && !turnPick
  );

  const onHunk = (
    patch: string,
    file: string,
    hunkIndex: number,
    action: "stage" | "unstage" | "discard"
  ) => {
    if (action === "discard") return void discardHunk(patch, file, hunkIndex);
    void applyHunk(patch, file, hunkIndex, true, action === "unstage");
  };

  const onFileAction = (
    file: GitFile,
    action: "stage" | "unstage" | "discard"
  ) => {
    if (action === "stage") return void stage([file.path]);
    if (action === "unstage") return void unstage([file.path]);
    void discardFile(file);
  };


  return (
    <SidePanel
      storageKey="changes"
      flushHeader
      embedded={embedded}
      onClose={onClose}
      // A turn review reads better wide; the working tree keeps the saved width.
      suggestedWidth={
        turnPick && turnPick.projectPath === projectPath ? PANEL_REVIEW_WIDTH : null
      }
      // Scope is the only chrome this panel owns now: branch actions, history
      // and committing moved to the top bar's git menu, so opening the diff no
      // longer starts halfway down the panel.
      header={
        !turnPick && gitFiles.length > 0 ? (
          <div className="flex flex-1 items-center gap-1 px-2 py-1">
            <ScopeButton
              active={scope === "working"}
              onClick={() => setScope("working")}
              label="Working tree"
              count={unstagedFiles.length}
            />
            <ScopeButton
              active={scope === "staged"}
              onClick={() => setScope("staged")}
              label="Staged"
              count={stagedFiles.length}
            />
            <button
              onClick={scope === "staged" ? unstageAll : stageAll}
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {scope === "staged" ? (
                <>
                  <Minus className="size-3" />
                  Unstage all
                </>
              ) : (
                <>
                  <Plus className="size-3" />
                  Stage all
                </>
              )}
            </button>
          </div>
        ) : (
          <span className="px-2 text-xs font-medium text-muted-foreground">Review</span>
        )
      }
      actions={
        <button
          onClick={() => invalidateGit(projectPath)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
          {turnPick && turnPick.projectPath === projectPath ? (
            <TurnReview
              pick={turnPick}
              onExit={onExitTurnPick}
              onPickTurn={(range) => onPickTurn({ ...turnPick, fromId: range.fromId })}
            />
          ) : (
            <>
              {gitFiles.length === 0 ? (
            <EmptyState icon={<GitBranch className="size-5" />}>
              No working-tree changes (or not a git repo).
            </EmptyState>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto">
                {commitPick ? (
                  <>
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-1 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {basename(commitPick.file)} · {commitPick.sha.slice(0, 7)}
                      </span>
                      <button
                        onClick={onExitCommitPick}
                        title="Back to working tree"
                        className="ml-auto shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                    <UnifiedDiff
                      text={commitDiffQuery.data ?? ""}
                      lang={langFromPath(commitPick.file)}
                      file={commitPick.file}
                    />
                  </>
                ) : (
                  <WorkingDiffView
                    patch={workingDiff.data ?? ""}
                    files={scope === "staged" ? stagedFiles : unstagedFiles}
                    staged={scope === "staged"}
                    // A `-w` patch has line counts that no longer match the
                    // file, so git apply rejects every hunk cut from it. Hide
                    // the buttons rather than offer an action that always fails.
                    hunkActions={!ignoreWhitespace}
                    // Staged and unstaged are two patches that can be the same
                    // length; without the scope in the key, one renders the
                    // other's parse.
                    cacheKey={`working:${scope}`}
                    onHunk={onHunk}
                    onFileAction={onFileAction}
                  />
                )}
              </div>
            </>
              )}
            </>
          )}
      </div>

      {historyFile && (
        <Suspense fallback={null}>
          <GitRewind
            projectPath={projectPath}
            file={historyFile}
            onClose={() => setHistoryFile(null)}
          />
        </Suspense>
      )}
    </SidePanel>
  );
}

/** Which half of the index the diff surface is showing. One patch describes one
 *  scope, so these are a toggle, not two lists. */
function ScopeButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      )}
    >
      {label}
      {count > 0 && <span className="tabular-nums opacity-60">{count}</span>}
    </button>
  );
}

/** Porcelain status for a turn file's kind, so the tree's `statusBadge` reads
 *  a turn delta and a working tree through the same path. */
const STATUS_OF_KIND: Record<"modified" | "added" | "deleted", string> = {
  modified: " M",
  added: "A ",
  deleted: " D",
};

/** One turn's file delta, the way the transcript's Review button opens it:
 *  the turn's file list with a filter, and the selected file's patch rendered
 *  by @pierre/diffs with expandable context. Read-only — staging lives in the
 *  working-tree view, and a turn's delta is history, not a work queue. */
function TurnReview({
  pick,
  onExit,
  onPickTurn,
}: {
  pick: TurnReviewRequest;
  onExit: () => void;
  onPickTurn: (range: TurnRange) => void;
}) {
  const checkpoints = useThreadCheckpoints(pick.projectPath, pick.threadId);
  const ranges = useMemo(
    () => turnRangesNewestFirst(checkpoints.data ?? []),
    [checkpoints.data]
  );
  const current = ranges.find((range) => range.fromId === pick.fromId);
  const { data: files } = useTurnFiles(pick.projectPath, pick.threadId, pick.fromId);
  const patch = useTurnPatch(pick.projectPath, pick.threadId, pick.fromId);
  const totals = useMemo(() => sumRangeFiles(files ?? []), [files]);
  // The tree speaks porcelain, and a turn's delta speaks kinds. One letter each,
  // so the same `statusBadge` reads both.
  const treeFiles = useMemo<GitFile[]>(
    () =>
      (files ?? []).map((file) => ({
        path: file.path,
        status: STATUS_OF_KIND[file.kind],
        untracked: false,
      })),
    [files]
  );
  // Per-turn options: the contents loader closes over this turn, and its
  // memo identity keeps the underlying FileDiff from restarting.
  const options = useMemo(
    () =>
      buildTurnReviewOptions(
        contentsToLoader((file) =>
          fetchTurnContents(pick.projectPath, pick.threadId, pick.fromId, file)
        )
      ),
    [pick.projectPath, pick.threadId, pick.fromId]
  );
  const truncated = (patch.data ?? "").endsWith("… patch truncated\n");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileDiff className="size-3.5 shrink-0" />
              <span className="max-w-56 truncate">{current?.label ?? "Turn"}</span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={onExit}>Working tree</DropdownMenuItem>
            <DropdownMenuSeparator />
            {ranges.map((range) => (
              <DropdownMenuItem
                key={range.fromId}
                disabled={range.fromId === pick.fromId}
                onSelect={() => onPickTurn(range)}
              >
                <span className="max-w-72 truncate">{range.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {files && files.length > 0 && (
          <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
            <span className="text-emerald-400">+{totals.additions}</span>
            <span className="text-red-400">−{totals.deletions}</span>
          </span>
        )}
        {truncated && (
          <span className="truncate text-[11px] text-amber-400">
            Large diff · showing the start
          </span>
        )}
        <button
          type="button"
          onClick={onExit}
          title="Back to working tree"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {!files ? (
        <EmptyState>Loading changes…</EmptyState>
      ) : files.length === 0 ? (
        <EmptyState>This turn changed no files.</EmptyState>
      ) : (
        <WorkingDiffView
          patch={patch.data ?? ""}
          files={treeFiles}
          staged={false}
          // A turn's delta is history, not a work queue: no staging, no
          // discarding, so the hunk and row actions stay out entirely.
          hunkActions={false}
          options={options}
          cacheKey={`turn:${pick.fromId}`}
        />
      )}
    </div>
  );
}





