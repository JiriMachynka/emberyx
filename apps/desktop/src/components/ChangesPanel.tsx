import { Suspense, lazy, memo, useEffect, useMemo, useState } from "react";
import { isStaged, isUnstaged } from "@/lib/gitStatus";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { PatchDiff } from "@pierre/diffs/react";
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

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { basename } from "@/lib/path";
import { parseDiff, hunkPatch } from "@/lib/hunks";
import { highlightCached, langFromPath } from "@/lib/highlight";
import {
  useGitChanges,
  useGitCommitDiff,
  useGitWorkingDiff,
  useInvalidateGit,
  useThreadCheckpoints,
  useTurnDiff,
  useTurnFiles,
  fetchTurnContents,
} from "@/lib/queries";
import { turnRangesNewestFirst, type TurnRange } from "@/lib/checkpoints";
import { buildTurnDiffOptions, contentsToLoader } from "@/lib/diffView";
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

/** True for unified-diff header lines that aren't source code. */
function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("@@") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  );
}

/** One syntax-highlighted diff line: marker gutter + highlighted code.
 *  Memoized so re-renders (e.g. streaming agent events) don't re-highlight
 *  unchanged lines — highlightCode is the expensive per-line work. */
const DiffLine = memo(function DiffLine({
  marker,
  code,
  lang,
  tint,
}: {
  marker: string;
  code: string;
  lang: string | null;
  tint: string;
}) {
  return (
    <div className={cn("border-l-2 border-transparent pr-2", tint)}>
      <span className="inline-block w-5 shrink-0 select-none text-center opacity-40">
        {marker}
      </span>
      <span dangerouslySetInnerHTML={{ __html: highlightCached(code, lang) || " " }} />
    </div>
  );
});

/** The body of one hunk, syntax-highlighted line by line. */
function HunkBody({ text, lang }: { text: string; lang: string | null }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        if (line === "")
          return (
            <div key={i} className="border-l-2 border-transparent pl-5">
              {" "}
            </div>
          );
        if (isDiffMeta(line)) {
          return (
            <div
              key={i}
              className="border-l-2 border-transparent pl-5 pr-2 text-muted-foreground"
            >
              {line}
            </div>
          );
        }
        const c = line[0];
        const tint =
          c === "+"
            ? "border-emerald-500/50 bg-emerald-500/15"
            : c === "-"
              ? "border-red-500/50 bg-red-500/15"
              : "";
        return (
          <DiffLine
            key={i}
            marker={c === "+" || c === "-" ? c : " "}
            code={line.slice(1)}
            lang={lang}
            tint={tint}
          />
        );
      })}
    </>
  );
}

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
          <HunkBody text={text} lang={lang} />
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
              <HunkBody text={hunk.text.slice(hunk.header.length + 1)} lang={lang} />
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
  const gitQuery = useGitChanges(projectPath, active);
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

  const applyHunk = (patch: string, cached: boolean, reverse: boolean) =>
    run(
      () => invoke("git_apply", { path: projectPath, patch, cached, reverse }),
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

  async function discardHunk(patch: string) {
    const ok = await ask("Discard this hunk? This can't be undone.", {
      title: "Discard hunk",
      kind: "warning",
    });
    if (ok) await applyHunk(patch, false, true);
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

  const onHunk = (patch: string, action: "stage" | "unstage" | "discard") => {
    if (action === "discard") return void discardHunk(patch);
    void applyHunk(patch, true, action === "unstage");
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
          <span className="px-2 text-xs font-medium text-muted-foreground">Diff</span>
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
            <Empty icon={<GitBranch className="size-5" />}>
              No working-tree changes (or not a git repo).
            </Empty>
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
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    if (!files) return null;
    const query = filter.trim().toLowerCase();
    return query
      ? files.filter((file) => file.path.toLowerCase().includes(query))
      : files;
  }, [files, filter]);
  // Follow the turn's file list: first visible file by default, and a
  // selection that left the list (rewind, checkout, filter) moves with it.
  useEffect(() => {
    if (!visible) return;
    if (!sel || !visible.some((file) => file.path === sel)) {
      setSel(visible[0]?.path ?? null);
    }
  }, [visible, sel]);
  const diff = useTurnDiff(pick.projectPath, pick.threadId, pick.fromId, sel);
  // Per-turn options: the contents loader closes over this turn, and its
  // memo identity keeps the underlying FileDiff from restarting.
  const options = useMemo(
    () =>
      buildTurnDiffOptions(
        contentsToLoader((file) =>
          fetchTurnContents(pick.projectPath, pick.threadId, pick.fromId, file)
        )
      ),
    [pick.projectPath, pick.threadId, pick.fromId]
  );
  const truncated = (diff.data ?? "").endsWith("… patch truncated\n");

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
        <Empty>Loading changes…</Empty>
      ) : files.length === 0 ? (
        <Empty>This turn changed no files.</Empty>
      ) : (
        <>
          <div className="shrink-0 border-b p-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              className="h-7 text-xs"
            />
          </div>
          <ul className="max-h-40 shrink-0 overflow-auto border-b">
            {(visible ?? []).map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setSel(file.path)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                    sel === file.path && "bg-secondary"
                  )}
                >
                  <FileTypeIcon path={file.path} />
                  <span className="flex-1 truncate" title={file.path}>
                    {file.path}
                  </span>
                  {file.additions != null && (
                    <span className="shrink-0 tabular-nums text-emerald-400">
                      +{file.additions}
                    </span>
                  )}
                  {file.deletions != null && (
                    <span className="shrink-0 tabular-nums text-red-400">
                      −{file.deletions}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="min-h-0 flex-1 overflow-auto">
            {sel && diff.data ? (
              <PatchDiff patch={diff.data} options={options} className="pierre-diffs" />
            ) : sel ? (
              <Empty>No diff to show.</Empty>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}





function Empty({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}
