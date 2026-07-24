import { memo, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { diffLines } from "diff";
import {
  FileDiff,
  RefreshCw,
  GitBranch,
  Bot,
  Check,
  Plus,
  Minus,
  Undo2,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { basename } from "@/lib/path";
import { parseDiff, hunkPatch } from "@/lib/hunks";
import { highlightCode, langFromPath } from "@/lib/highlight";
import { useGitChanges, useGitFileDiff, useInvalidateGit } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import type { Change } from "@/lib/changes";
import type { GitFile } from "@/types";
import { GitActions } from "@/components/GitActions";
import { GitRewind } from "@/components/GitRewind";
import { SidePanel } from "@/components/SidePanel";

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
      <span dangerouslySetInnerHTML={{ __html: highlightCode(code, lang) || " " }} />
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

/** jsdiff view of an agent edit (old vs new), syntax-highlighted. */
function EditDiff({ change }: { change: Change }) {
  const lang = useMemo(() => langFromPath(change.file), [change.file]);
  const parts = useMemo(
    () => diffLines(change.oldText, change.newText),
    [change.oldText, change.newText]
  );
  return (
    <pre className="overflow-x-auto whitespace-pre py-1 font-mono text-xs leading-relaxed">
      <div className="w-max min-w-full">
        {parts.map((part, i) =>
          part.value
            .replace(/\n$/, "")
            .split("\n")
            .map((line, j) => (
              <DiffLine
                key={`${i}-${j}`}
                marker={part.added ? "+" : part.removed ? "-" : " "}
                code={line}
                lang={lang}
                tint={
                  part.added
                    ? "border-emerald-500/50 bg-emerald-500/15"
                    : part.removed
                      ? "border-red-500/50 bg-red-500/15"
                      : ""
                }
              />
            ))
        )}
      </div>
    </pre>
  );
}

/** Which side of a file is being viewed — the same path can be both staged and
 *  unstaged, with a different diff on each side. */
interface Selection {
  path: string;
  staged: boolean;
}

/** Index column dirty (porcelain X): the file has something staged. */
const isStaged = (f: GitFile) =>
  !f.untracked && f.status[0] !== " " && f.status[0] !== "?";

/** Worktree column dirty (porcelain Y), or the file is untracked. */
const isUnstaged = (f: GitFile) =>
  f.untracked || (f.status[1] !== " " && f.status[1] !== "?");

interface ChangesPanelProps {
  projectPath: string;
  /** Session ids in this project — selects its slice of the agent edit feed. */
  sessionIds: string[];
  openRouterApiKey: string;
  openRouterModel: string;
  onClose: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
}

export function ChangesPanel({
  projectPath,
  sessionIds,
  openRouterApiKey,
  openRouterModel,
  onClose,
  onOpenWorktree,
  onRemoveWorktree,
}: ChangesPanelProps) {
  const [tab, setTab] = useState<"git" | "agent">("git");
  const [fileListHeight, setFileListHeight] = useState(208);

  // This project's slice of the live agent edit feed. Select the whole feed
  // (its ref only changes when edits arrive) then filter, so status/usage
  // updates don't re-render the panel.
  const allChanges = useAgentStore((s) => s.changes);
  const changes = useMemo(
    () => allChanges.filter((c) => sessionIds.includes(c.session)),
    [allChanges, sessionIds]
  );

  // Git tab state. The index is the source of truth: a file shows up under
  // "Staged" when its index column is dirty and under "Changes" when its
  // worktree column is, so partly-staged files appear in both.
  const gitQuery = useGitChanges(projectPath);
  const gitFiles = useMemo(() => gitQuery.data ?? [], [gitQuery.data]);
  const stagedFiles = gitFiles.filter(isStaged);
  const unstagedFiles = gitFiles.filter(isUnstaged);

  const [gitSel, setGitSel] = useState<Selection | null>(null);
  const selFile = gitFiles.find((f) => f.path === gitSel?.path);
  const diffQuery = useGitFileDiff(
    projectPath,
    gitSel?.path ?? null,
    selFile?.untracked ?? false,
    gitSel?.staged ?? false
  );
  const gitDiff = diffQuery.data ?? "";
  const invalidateGit = useInvalidateGit();

  // Commit state.
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // Agent tab state.
  const [agentSelId, setAgentSelId] = useState<number | null>(null);
  const agentSel =
    changes.find((c) => c.id === agentSelId) ?? changes[changes.length - 1];

  // Clear a selection whose side of the file went away (staged, committed,
  // discarded), so the pane never shows a diff that no longer exists.
  useEffect(() => {
    if (!gitQuery.data || !gitSel) return;
    const still = gitQuery.data.some(
      (f) => f.path === gitSel.path && (gitSel.staged ? isStaged(f) : isUnstaged(f))
    );
    if (!still) setGitSel(null);
  }, [gitQuery.data, gitSel]);

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

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = fileListHeight;
    const onMove = (ev: MouseEvent) => {
      const max = Math.round(window.innerHeight * 0.6);
      const next = Math.min(max, Math.max(80, startH + ev.clientY - startY));
      setFileListHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  async function generateMessage() {
    const files = stagedFiles.map((f) => f.path);
    if (!files.length || generating) return;
    setGenerating(true);
    setCommitErr(null);
    try {
      const msg = await invoke<string>("generate_commit_message", {
        path: projectPath,
        files,
        apiKey: openRouterApiKey,
        model: openRouterModel,
      });
      setCommitMsg(msg);
    } catch (e) {
      setCommitErr(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function doCommit() {
    if (!stagedFiles.length || !commitMsg.trim() || committing) return;
    setCommitting(true);
    setCommitErr(null);
    try {
      await invoke<string>("git_commit", {
        path: projectPath,
        message: commitMsg.trim(),
      });
      setCommitMsg("");
      setGitSel(null);
      invalidateGit(projectPath);
    } catch (e) {
      setCommitErr(String(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <SidePanel
      storageKey="changes"
      flushHeader
      onClose={onClose}
      header={
        <div className="flex items-center">
          <TabButton
            active={tab === "git"}
            onClick={() => setTab("git")}
            icon={<GitBranch className="size-4" />}
            label={`Git${gitFiles.length ? ` (${gitFiles.length})` : ""}`}
          />
          <TabButton
            active={tab === "agent"}
            onClick={() => setTab("agent")}
            icon={<Bot className="size-4" />}
            label={`Agent${changes.length ? ` (${changes.length})` : ""}`}
          />
        </div>
      }
      actions={
        tab === "git" && (
          <button
            onClick={() => invalidateGit(projectPath)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )
      }
    >
      {tab === "git" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <GitActions
            projectPath={projectPath}
            onOpenWorktree={onOpenWorktree}
            onRemoveWorktree={onRemoveWorktree}
          />
          {gitFiles.length === 0 ? (
            <Empty icon={<GitBranch className="size-5" />}>
              No working-tree changes (or not a git repo).
            </Empty>
          ) : (
            <>
              <div
                className="shrink-0 overflow-auto border-b"
                style={{ height: fileListHeight }}
              >
                {stagedFiles.length > 0 && (
                  <>
                    <SectionHeader
                      label="Staged Changes"
                      count={stagedFiles.length}
                      actionIcon={<Minus className="size-3" />}
                      actionTitle="Unstage all"
                      onAction={unstageAll}
                    />
                    <ul>
                      {stagedFiles.map((f) => (
                        <GitFileRow
                          key={f.path}
                          file={f}
                          staged
                          selected={gitSel?.path === f.path && gitSel.staged}
                          onSelect={() => setGitSel({ path: f.path, staged: true })}
                          onToggle={() => void unstage([f.path])}
                          onHistory={() => setHistoryFile(f.path)}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {unstagedFiles.length > 0 && (
                  <>
                    <SectionHeader
                      label="Changes"
                      count={unstagedFiles.length}
                      actionIcon={<Plus className="size-3" />}
                      actionTitle="Stage all changes"
                      onAction={stageAll}
                    />
                    <ul>
                      {unstagedFiles.map((f) => (
                        <GitFileRow
                          key={f.path}
                          file={f}
                          staged={false}
                          selected={gitSel?.path === f.path && !gitSel.staged}
                          onSelect={() => setGitSel({ path: f.path, staged: false })}
                          onToggle={() => void stage([f.path])}
                          onDiscard={() => void discardFile(f)}
                          onHistory={f.untracked ? undefined : () => setHistoryFile(f.path)}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div
                onMouseDown={startResize}
                title="Drag to resize"
                className="h-1 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-primary/40"
              />
              {stagedFiles.length > 0 && (
                <div className="shrink-0 space-y-1.5 border-b p-2">
                  <Input
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doCommit();
                    }}
                    placeholder={`Commit message for ${stagedFiles.length} file${
                      stagedFiles.length > 1 ? "s" : ""
                    }…`}
                    className="h-8 text-xs"
                  />
                  {commitErr && (
                    <p className="whitespace-pre-wrap text-[11px] text-red-400">
                      {commitErr}
                    </p>
                  )}
                  <div className="flex justify-end gap-2">
                    {openRouterApiKey.trim() && (
                      <button
                        onClick={() => void generateMessage()}
                        disabled={generating}
                        title="Draft a commit message from the staged diff"
                        className="mr-auto flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                      >
                        {generating ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : (
                          <Bot className="size-3.5" />
                        )}
                        Generate
                      </button>
                    )}
                    <button
                      onClick={unstageAll}
                      className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      Unstage all
                    </button>
                    <button
                      onClick={() => void doCommit()}
                      disabled={committing || !commitMsg.trim()}
                      className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      <Check className="size-3.5" />
                      Commit {stagedFiles.length}
                    </button>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                {gitSel ? (
                  <>
                    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-1 text-[11px] text-muted-foreground">
                      <span className="truncate">{gitSel.path}</span>
                      <span className="ml-auto shrink-0">
                        {gitSel.staged ? "staged" : "working tree"}
                      </span>
                    </div>
                    <UnifiedDiff
                      text={gitDiff}
                      lang={langFromPath(gitSel.path)}
                      file={gitSel.path}
                      actions={(patch) =>
                        gitSel.staged ? (
                          <HunkButton
                            title="Unstage this hunk"
                            onClick={() => void applyHunk(patch, true, true)}
                          >
                            <Minus className="size-3" />
                            Unstage
                          </HunkButton>
                        ) : (
                          <>
                            <HunkButton
                              title="Discard this hunk"
                              onClick={() => void discardHunk(patch)}
                            >
                              <Undo2 className="size-3" />
                              Discard
                            </HunkButton>
                            <HunkButton
                              title="Stage this hunk"
                              onClick={() => void applyHunk(patch, true, false)}
                            >
                              <Plus className="size-3" />
                              Stage
                            </HunkButton>
                          </>
                        )
                      }
                    />
                  </>
                ) : (
                  <Empty>Select a file to see its diff.</Empty>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {changes.length === 0 ? (
            <Empty icon={<FileDiff className="size-5" />}>
              Edits the agent makes show up here.
            </Empty>
          ) : (
            <>
              <ul className="max-h-40 shrink-0 overflow-auto border-b">
                {[...changes].reverse().map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => setAgentSelId(c.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                        agentSel?.id === c.id && "bg-secondary"
                      )}
                    >
                      <span className="rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                        {c.tool}
                      </span>
                      <span className="flex-1 truncate">{basename(c.file)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {agentSel && (
                <div className="min-h-0 flex-1 overflow-auto">
                  <div className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                    {agentSel.file}
                  </div>
                  <EditDiff change={agentSel} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {historyFile && (
        <GitRewind
          projectPath={projectPath}
          file={historyFile}
          onClose={() => setHistoryFile(null)}
        />
      )}
    </SidePanel>
  );
}

/** VS Code-style group header ("Staged Changes" / "Changes") with a count and
 *  a bulk stage/unstage action button on the right. */
function SectionHeader({
  label,
  count,
  actionIcon,
  actionTitle,
  onAction,
}: {
  label: string;
  count: number;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onAction: () => void;
}) {
  return (
    <div className="group sticky top-0 flex items-center justify-between bg-card px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={onAction}
          title={actionTitle}
          className="rounded p-0.5 hover:bg-accent hover:text-foreground"
        >
          {actionIcon}
        </button>
        <span className="tabular-nums">{count}</span>
      </div>
    </div>
  );
}

/** Small button in a hunk's action bar. */
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
      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** One file row: click to view its diff, hover-reveal stage/unstage (and
 *  discard, on the working-tree side). */
function GitFileRow({
  file,
  staged,
  selected,
  onSelect,
  onToggle,
  onDiscard,
  onHistory,
}: {
  file: GitFile;
  staged: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDiscard?: () => void;
  onHistory?: () => void;
}) {
  return (
    <li
      className={cn(
        "group flex items-center gap-1 pr-1",
        selected && "bg-secondary"
      )}
    >
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left text-xs hover:text-foreground"
        title={file.path}
      >
        <span
          className={cn(
            "w-4 shrink-0 text-center font-mono text-[10px]",
            file.untracked ? "text-emerald-400" : "text-amber-400"
          )}
        >
          {file.untracked ? "U" : file.status.trim() || "M"}
        </span>
        <span className="flex-1 truncate">{file.path}</span>
      </button>
      {onHistory && (
        <button
          onClick={onHistory}
          title="File history"
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
        >
          <History className="size-3.5" />
        </button>
      )}
      {onDiscard && (
        <button
          onClick={onDiscard}
          title={file.untracked ? "Delete file" : "Discard changes"}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover:opacity-100"
        >
          <Undo2 className="size-3.5" />
        </button>
      )}
      <button
        onClick={onToggle}
        title={staged ? "Unstage" : "Stage"}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
      </button>
    </li>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-3 py-1.5 text-sm",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
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
