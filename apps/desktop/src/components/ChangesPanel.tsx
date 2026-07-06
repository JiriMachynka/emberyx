import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { diffLines } from "diff";
import { X, FileDiff, RefreshCw, GitBranch, Bot, Check, Plus, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { basename } from "@/lib/path";
import { highlightCode, langFromPath } from "@/lib/highlight";
import type { Change } from "@/lib/changes";
import type { GitFile } from "@/types";
import { GitActions } from "@/components/GitActions";

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
    <div className={cn("px-1", tint)}>
      <span className="select-none opacity-40">{marker} </span>
      <span dangerouslySetInnerHTML={{ __html: highlightCode(code, lang) || " " }} />
    </div>
  );
});

/** Raw unified diff with per-line syntax highlighting. */
function UnifiedDiff({ text, lang }: { text: string; lang: string | null }) {
  if (!text.trim()) {
    return (
      <div className="p-3 text-xs text-muted-foreground">No diff to show.</div>
    );
  }
  return (
    <pre className="overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs leading-relaxed">
      {text.split("\n").map((line, i) => {
        if (line === "") return <div key={i} className="px-1">{" "}</div>;
        if (isDiffMeta(line)) {
          return (
            <div
              key={i}
              className={cn(
                "px-1",
                line.startsWith("@@") ? "text-sky-400" : "text-muted-foreground"
              )}
            >
              {line}
            </div>
          );
        }
        const c = line[0];
        const tint =
          c === "+" ? "bg-emerald-500/15" : c === "-" ? "bg-red-500/15" : "";
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
    </pre>
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
    <pre className="overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs leading-relaxed">
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
                  ? "bg-emerald-500/15"
                  : part.removed
                    ? "bg-red-500/15"
                    : ""
              }
            />
          ))
      )}
    </pre>
  );
}

interface ChangesPanelProps {
  projectPath: string;
  changes: Change[];
  openRouterApiKey: string;
  openRouterModel: string;
  onClose: () => void;
}

export function ChangesPanel({
  projectPath,
  changes,
  openRouterApiKey,
  openRouterModel,
  onClose,
}: ChangesPanelProps) {
  const [tab, setTab] = useState<"git" | "agent">("git");

  // Git tab state.
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitSel, setGitSel] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState("");
  // Bumped on every reload so GitActions re-fetches branch/ahead-behind too.
  const [gitVersion, setGitVersion] = useState(0);

  // Commit state.
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitErr, setCommitErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // Agent tab state.
  const [agentSelId, setAgentSelId] = useState<number | null>(null);
  const agentSel =
    changes.find((c) => c.id === agentSelId) ?? changes[changes.length - 1];

  const loadGit = useCallback(() => {
    invoke<GitFile[]>("git_changes", { path: projectPath })
      .then((files) => {
        setGitFiles(files);
        // Drop staged entries whose files no longer have changes.
        const present = new Set(files.map((f) => f.path));
        setStaged((prev) => new Set([...prev].filter((p) => present.has(p))));
        setGitVersion((v) => v + 1);
      })
      .catch((e) => console.error("git_changes failed:", e));
  }, [projectPath]);

  useEffect(() => {
    loadGit();
  }, [loadGit]);

  function selectGit(f: GitFile) {
    setGitSel(f.path);
    setGitDiff("");
    invoke<string>("git_file_diff", {
      path: projectPath,
      file: f.path,
      untracked: f.untracked,
    })
      .then(setGitDiff)
      .catch((e) => console.error("git_file_diff failed:", e));
  }

  function toggleStage(path: string) {
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const stagedFiles = gitFiles.filter((f) => staged.has(f.path));
  const unstagedFiles = gitFiles.filter((f) => !staged.has(f.path));

  const stageAll = () => setStaged(new Set(gitFiles.map((f) => f.path)));
  const unstageAll = () => setStaged(new Set());

  async function generateMessage() {
    const files = [...staged];
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
    const files = [...staged];
    if (!files.length || !commitMsg.trim() || committing) return;
    setCommitting(true);
    setCommitErr(null);
    try {
      await invoke<string>("git_commit", {
        path: projectPath,
        files,
        message: commitMsg.trim(),
      });
      setStaged(new Set());
      setCommitMsg("");
      setGitSel(null);
      setGitDiff("");
      loadGit();
    } catch (e) {
      setCommitErr(String(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l bg-card">
      <header className="flex h-9 shrink-0 items-center justify-between border-b pl-1 pr-2">
        <div className="flex items-center">
          <TabButton
            active={tab === "git"}
            onClick={() => setTab("git")}
            icon={<GitBranch className="size-3.5" />}
            label={`Git${gitFiles.length ? ` (${gitFiles.length})` : ""}`}
          />
          <TabButton
            active={tab === "agent"}
            onClick={() => setTab("agent")}
            icon={<Bot className="size-3.5" />}
            label={`Agent${changes.length ? ` (${changes.length})` : ""}`}
          />
        </div>
        <div className="flex items-center gap-1">
          {tab === "git" && (
            <button
              onClick={loadGit}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>

      {tab === "git" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <GitActions
            projectPath={projectPath}
            reloadKey={gitVersion}
            onRefresh={loadGit}
          />
          {gitFiles.length === 0 ? (
            <Empty icon={<GitBranch className="size-5" />}>
              No working-tree changes (or not a git repo).
            </Empty>
          ) : (
            <>
              <div className="max-h-52 shrink-0 overflow-auto border-b">
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
                          selected={gitSel === f.path}
                          onSelect={() => selectGit(f)}
                          onToggle={() => toggleStage(f.path)}
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
                          selected={gitSel === f.path}
                          onSelect={() => selectGit(f)}
                          onToggle={() => toggleStage(f.path)}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </div>
              {staged.size > 0 && (
                <div className="shrink-0 space-y-1.5 border-b p-2">
                  <Input
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doCommit();
                    }}
                    placeholder={`Commit message for ${staged.size} file${
                      staged.size > 1 ? "s" : ""
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
                      onClick={() => setStaged(new Set())}
                      className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      Clear
                    </button>
                    <button
                      onClick={() => void doCommit()}
                      disabled={committing || !commitMsg.trim()}
                      className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      <Check className="size-3.5" />
                      Commit {staged.size}
                    </button>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                {gitSel ? (
                  <UnifiedDiff text={gitDiff} lang={langFromPath(gitSel)} />
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
    </aside>
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

/** One file row: click to view its diff, hover-reveal a stage/unstage button. */
function GitFileRow({
  file,
  staged,
  selected,
  onSelect,
  onToggle,
}: {
  file: GitFile;
  staged: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
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
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs",
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
