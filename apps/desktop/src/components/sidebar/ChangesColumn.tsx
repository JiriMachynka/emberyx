import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  GitCommitVertical,
  GitPullRequest,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { GitActions } from "@/components/GitActions";
import { RecentCommits } from "@/components/RecentCommits";
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { isStaged, isUnstaged } from "@/lib/gitStatus";
import {
  menuActions,
  needsMessage,
  opensPr,
  pushes,
  type GitActionKind,
  type GitActionState,
} from "@/lib/gitAction";
import { FORGE_NOUN, isRemoteHost, type RemoteHost } from "@/lib/forge";
import { loadSettings } from "@/lib/settings";
import { gitStatusInterval, useForgeCliStatus, useForgeOpenPr, useGitBranch, useGitChanges, useGitDefaultBranch, useInvalidateGit } from "@/lib/queries";
import { useAgentStore } from "@/lib/agentStore";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CommitPush, GitFile } from "@/types";

const ACTION_ICON: Record<GitActionKind, typeof GitCommitVertical> = {
  commitPush: ArrowUpFromLine,
  commit: GitCommitVertical,
  commitPushPr: GitPullRequest,
  push: ArrowUp,
  pushPr: GitPullRequest,
  openPr: GitPullRequest,
  pull: ArrowDown,
};

const subjectOf = (message: string) => message.trim().split("\n")[0] ?? "";

const statusLetter = (file: GitFile): string => {
  if (file.untracked) return "U";
  const index = file.status[0];
  const work = file.status[1];
  if (index && index !== " " && index !== "?") return index;
  if (work && work !== " " && work !== "?") return work;
  return "M";
};

const statusColor = (letter: string): string => {
  if (letter === "A" || letter === "?") return "text-emerald-400";
  if (letter === "D") return "text-destructive";
  if (letter === "U") return "text-emerald-400";
  return "text-amber-400";
};

export function ChangesColumn({
  projectPath,
  rightDock,
  remoteHost,
  onOpenReview,
  onOpenWorktree,
  onRemoveWorktree,
}: {
  projectPath: string;
  rightDock: boolean;
  remoteHost: string | undefined;
  onOpenReview: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const drafting = useRef(false);

  const branchQuery = useGitBranch(projectPath);
  const changesQuery = useGitChanges(
    projectPath,
    true,
    gitStatusInterval("watch")
  );
  const defaultBranchQuery = useGitDefaultBranch(projectPath);
  const forge = isRemoteHost(remoteHost ?? "") ? (remoteHost as RemoteHost) : undefined;
  const branch = branchQuery.data;
  const openPrQuery = useForgeOpenPr(projectPath, forge, branch?.branch);
  const cliStatus = useForgeCliStatus();
  const invalidateGit = useInvalidateGit();
  const requestCommitReview = useAgentStore((s) => s.requestCommitReview);

  const files = changesQuery.data ?? [];
  const staged = files.filter(isStaged);
  const unstaged = files.filter(isUnstaged);
  const canOpenPr =
    !!forge &&
    !!cliStatus.data?.find((c) => c.id === forge)?.authenticated;

  const noun = FORGE_NOUN[forge ?? "github"].one;

  const draftMessage = () =>
    invoke<string>("git_draft_commit_message", {
      path: projectPath,
      model: loadSettings().commitMessageModel,
    });

  const fillDraft = async () => {
    if (message.trim() || files.length === 0 || drafting.current) return;
    const model = loadSettings().commitMessageModel;
    if (!model) return;
    drafting.current = true;
    void invoke("draft_warm", { model }).catch(() => {});
    try {
      setMessage(await draftMessage());
    } catch {
      // The box stays empty; commit will try again or refuse.
    } finally {
      drafting.current = false;
    }
  };

  async function runGit(fn: () => Promise<unknown>, fail: string) {
    try {
      await fn();
      invalidateGit(projectPath);
    } catch (e) {
      toast.error(fail, { description: String(e) });
    }
  }

  const stage = (paths: string[]) =>
    runGit(
      () => invoke("git_stage", { path: projectPath, files: paths }),
      "Couldn't stage"
    );
  const unstage = (paths: string[]) =>
    runGit(
      () => invoke("git_unstage", { path: projectPath, files: paths }),
      "Couldn't unstage"
    );

  async function discardFile(file: GitFile) {
    const ok = await ask(
      file.untracked
        ? `Delete ${file.path}? This can't be undone.`
        : `Discard all changes to ${file.path}? This can't be undone.`,
      { title: "Discard changes", kind: "warning" }
    );
    if (!ok) return;
    await runGit(
      () =>
        invoke("git_discard", {
          path: projectPath,
          files: [file.path],
          untracked: file.untracked,
        }),
      "Couldn't discard"
    );
  }

  const state: GitActionState | null = branch
    ? {
        staged: staged.length,
        unstaged: unstaged.length,
        ahead: branch.ahead,
        behind: branch.behind,
        upstream: branch.upstream,
        isDefaultBranch:
          !!defaultBranchQuery.data && defaultBranchQuery.data === branch.branch,
        openPr: openPrQuery.data ?? null,
        canOpenPr,
      }
    : null;
  const actions = state ? menuActions(state) : [];
  const primary = actions.find((a) => a.kind === "commit") ?? actions[0];

  async function stageForCommit() {
    if (staged.length > 0 || unstaged.length === 0) return;
    await invoke("git_stage", {
      path: projectPath,
      files: unstaged.map((f) => f.path),
    });
  }

  async function commitAndPush(text: string): Promise<boolean> {
    let out = await invoke<CommitPush>("git_commit_and_push", {
      path: projectPath,
      message: text,
      setUpstream: false,
    });
    if (out.needsUpstream) {
      const publish = await ask(
        `"${out.branch}" isn't on the remote yet. Push it to origin and track it?`,
        { title: "Publish branch", kind: "info" }
      );
      if (!publish) return false;
      out = await invoke<CommitPush>("git_commit_and_push", {
        path: projectPath,
        message: text,
        setUpstream: true,
      });
    }
    if (out.committed && !out.pushed) {
      toast.warning("Committed, but not pushed", { description: out.message });
      return false;
    }
    if (out.pushed) {
      const url = await invoke<string | null>("git_head_commit_url", {
        path: projectPath,
      }).catch(() => null);
      toast.success(`Pushed to ${out.branch}`, {
        description: subjectOf(text),
        action: url
          ? { label: "Read more…", onClick: () => void openUrl(url) }
          : undefined,
      });
    }
    return out.pushed;
  }

  async function run(kind: GitActionKind, label: string) {
    if (busy || !branch) return;
    if (pushes(kind) && state?.isDefaultBranch) {
      const ok = await ask(
        `This will push to ${branch.branch}, the default branch.`,
        { title: `${label} to default branch?`, kind: "warning" }
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      let pushed = true;
      let text = message.trim();
      if (needsMessage(kind)) {
        if (!text) {
          const model = loadSettings().commitMessageModel;
          if (!model) {
            toast.error("No commit-message model set", {
              description:
                "Write a message, or pick a model in Settings → Source Control.",
            });
            return;
          }
          text = await draftMessage();
          setMessage(text);
        }
        await stageForCommit();
      }
      if (kind === "commit") {
        await invoke<string>("git_commit", { path: projectPath, message: text });
        const url = await invoke<string | null>("git_head_commit_url", {
          path: projectPath,
        }).catch(() => null);
        toast.success("Committed", {
          description: subjectOf(text),
          action: url
            ? { label: "Read more…", onClick: () => void openUrl(url) }
            : undefined,
        });
        setMessage("");
      } else if (kind === "commitPush" || kind === "commitPushPr") {
        pushed = await commitAndPush(text);
        if (pushed) setMessage("");
      } else if (kind === "push" || kind === "pushPr") {
        if (branch.upstream) {
          await invoke<string>("git_push", { path: projectPath });
        } else {
          await invoke<string>("git_push_to", {
            path: projectPath,
            remote: "origin",
            branch: branch.branch,
          });
        }
        toast.success(`Pushed ${branch.branch}`);
      } else if (kind === "pull") {
        await invoke<string>("git_pull", { path: projectPath });
        toast.success("Pulled");
      }
      if (opensPr(kind) && pushed) {
        const [title, ...rest] = text.split("\n");
        const url = await invoke<string>("forge_pr_create", {
          path: projectPath,
          provider: forge,
          title: title || branch.branch,
          body: rest.join("\n").trim(),
          base: defaultBranchQuery.data ?? null,
        });
        toast.success(`Opened ${noun}`, {
          description: subjectOf(text),
          action: { label: "Read more…", onClick: () => void openUrl(url) },
        });
      }
    } catch (e) {
      toast.error(`${label} failed`, { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  }

  const pickFile = (file: GitFile) => {
    setSelected(file.path);
    if (rightDock) onOpenReview();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-sm font-medium">Changes</span>
      </div>
      <GitActions
        projectPath={projectPath}
        onOpenWorktree={onOpenWorktree}
        onRemoveWorktree={onRemoveWorktree}
      />

      <div className="grid gap-2 border-b px-3 py-2">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onFocus={() => void fillDraft()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (primary && !primary.disabledReason) {
                void run(primary.kind, primary.label);
              }
            }
          }}
          placeholder="Message (⌘⏎ to commit)"
          className="min-h-16 resize-none text-xs"
        />
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            className="min-w-0 flex-1"
            disabled={busy || !primary || !!primary.disabledReason}
            title={primary?.disabledReason}
            onClick={() => primary && void run(primary.kind, primary.label)}
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {primary?.label ?? "Commit"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                title="More git actions"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {actions.map((action) => {
                const Icon = ACTION_ICON[action.kind];
                return (
                  <DropdownMenuItem
                    key={action.kind}
                    disabled={busy || !!action.disabledReason}
                    title={action.disabledReason}
                    onSelect={() => void run(action.kind, action.label)}
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    {action.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Changes</span>
        {files.length > 0 && (
          <span className="rounded bg-primary/15 px-1.5 tabular-nums text-primary">
            {files.length}
          </span>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title="Stage all"
            disabled={unstaged.length === 0}
            onClick={() => void stage(unstaged.map((f) => f.path))}
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3" />
          </button>
          <button
            type="button"
            title="Unstage all"
            disabled={staged.length === 0}
            onClick={() => void unstage(staged.map((f) => f.path))}
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Minus className="size-3" />
          </button>
          <button
            type="button"
            title="Refresh"
            onClick={() => void changesQuery.refetch()}
            className="rounded p-1 hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3" />
          </button>
        </span>
      </div>

      <ul className="min-h-0 flex-1 overflow-auto px-1 pb-1">
        {files.length === 0 ? (
          <li className="px-2 py-3 text-center text-xs text-muted-foreground">
            No working-tree changes
          </li>
        ) : (
          files.map((file) => {
            const letter = statusLetter(file);
            const dir = file.path.includes("/") ? dirname(file.path) : "";
            const open = selected === file.path;
            return (
              <li key={file.path} className="group/file flex items-center">
                <button
                  type="button"
                  onClick={() => pickFile(file)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent",
                    open && "bg-accent text-foreground"
                  )}
                >
                  <FileTypeIcon path={file.path} />
                  <span className="min-w-0 flex-1 truncate">
                    {basename(file.path)}
                    {dir && (
                      <span className="ml-1.5 text-muted-foreground">{dir}</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "w-4 shrink-0 text-center font-mono text-[10px]",
                      statusColor(letter)
                    )}
                  >
                    {letter}
                  </span>
                </button>
                <button
                  type="button"
                  title={isUnstaged(file) ? "Stage" : "Unstage"}
                  onClick={() =>
                    void (isUnstaged(file)
                      ? stage([file.path])
                      : unstage([file.path]))
                  }
                  className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover/file:opacity-100"
                >
                  {isUnstaged(file) ? (
                    <Plus className="size-3" />
                  ) : (
                    <Minus className="size-3" />
                  )}
                </button>
                <button
                  type="button"
                  title="Discard"
                  onClick={() => void discardFile(file)}
                  className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover/file:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              </li>
            );
          })
        )}
      </ul>

      <RecentCommits
        projectPath={projectPath}
        title="Graph"
        onPickCommitFile={(sha, file, subject) => {
          requestCommitReview({ projectPath, sha, file, subject });
          if (rightDock) onOpenReview();
        }}
      />
    </div>
  );
}
