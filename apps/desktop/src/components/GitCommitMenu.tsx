import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  GitCommitVertical,
  GitPullRequest,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { isStaged, isUnstaged } from "@/lib/gitStatus";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import {
  useForgeCliStatus,
  useForgeOpenPr,
  useGitBranch,
  useGitChanges,
  useGitDefaultBranch,
  useInvalidateGit,
} from "@/lib/queries";
import type { CommitPush } from "@/types";

/** One icon per action, so the list is scannable without reading it. A full
 *  record rather than a lookup with a fallback: a new kind has to be given an
 *  icon here, not silently inherit a generic one. Pull and Push match the
 *  arrows `GitActions` already uses for the same two moves. */
const ACTION_ICON: Record<GitActionKind, typeof GitCommitVertical> = {
  commitPush: ArrowUpFromLine,
  commit: GitCommitVertical,
  push: ArrowUp,
  commitPushPr: GitPullRequest,
  pushPr: GitPullRequest,
  openPr: GitPullRequest,
  pull: ArrowDown,
};

/** A commit message's first line — the body is draft context, not toast copy. */
const subjectOf = (message: string) => message.trim().split("\n")[0] ?? "";

/** The "Read more…" action, only when there is a page to read. */
const readMore = (url: string | null) =>
  url
    ? {
        label: "Read more…",
        onClick: () => void openUrl(url),
      }
    : undefined;

interface GitCommitMenuProps {
  projectPath: string;
  /** Which forge the origin remote is on; undefined for a repo without one. */
  remoteHost: string | undefined;
}

/**
 * Commit / push / open-PR from the top bar.
 *
 * One menu, listing the same moves in the same order every time — see
 * `lib/gitAction.ts`. There is no message box: the message is written from the
 * diff by a one-shot model call when a commit action runs, so committing is one
 * click rather than a writing task. An action the repo can't do right now stays
 * listed and disabled with the reason.
 */
export function GitCommitMenu({ projectPath, remoteHost }: GitCommitMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read once on mount, not per render: this menu lives in the top bar, which
  // re-renders often, and `loadSettings` parses and migrates the whole blob.
  const [draftModel] = useState(() => loadSettings().commitMessageModel);
  /** A draft started when the menu opened, keyed by the change set it describes.
   *  Dropped when the menu closes: the key sees a file's status, not its bytes,
   *  so a draft is only trusted for as long as the menu it was started for. */
  const draftRef = useRef<{
    key: string;
    result: Promise<{ message: string } | { error: unknown }>;
  } | null>(null);

  const branchQuery = useGitBranch(projectPath);
  const changesQuery = useGitChanges(projectPath);
  const defaultBranchQuery = useGitDefaultBranch(projectPath);
  const forge = isRemoteHost(remoteHost ?? "") ? (remoteHost as RemoteHost) : undefined;
  const branch = branchQuery.data;
  const openPrQuery = useForgeOpenPr(projectPath, forge, branch?.branch);
  const cliStatus = useForgeCliStatus();
  const invalidateGit = useInvalidateGit();

  if (!branch) return null;

  const files = changesQuery.data ?? [];
  const staged = files.filter(isStaged);
  const unstaged = files.filter(isUnstaged);
  // A forge that isn't installed or isn't logged in can't open anything — the
  // menu says so by not offering it, rather than by failing on click.
  const canOpenPr =
    !!forge &&
    !!cliStatus.data?.find((c) => c.id === forge)?.authenticated;

  const state: GitActionState = {
    staged: staged.length,
    unstaged: unstaged.length,
    ahead: branch.ahead,
    behind: branch.behind,
    upstream: branch.upstream,
    isDefaultBranch: !!defaultBranchQuery.data && defaultBranchQuery.data === branch.branch,
    openPr: openPrQuery.data ?? null,
    canOpenPr,
  };
  const actions = menuActions(state);
  const noun = FORGE_NOUN[forge ?? "github"].one;

  /** The message for this commit, written from the diff. Conventional Commits
   *  format — the prompt lives in `git.rs`. */
  async function draftMessage(): Promise<string> {
    return invoke<string>("git_draft_commit_message", {
      path: projectPath,
      model: draftModel,
    });
  }

  /** What the draft describes. Two change sets with the same files in the same
   *  states draft the same message. */
  const changeKey = files.map((f) => `${f.status}:${f.path}`).join("|");

  /**
   * Start the work the click is going to need, when the menu opens.
   *
   * Two halves, because they cost different things. Warming spawns a `claude`
   * that waits on stdin — free, so it runs whenever the menu opens. Drafting
   * spends a model call, so it only runs when there is something to commit;
   * opening the menu to hit Pull must not bill for a message nobody asked for.
   */
  function prefetch() {
    if (!draftModel) return;
    void invoke("draft_warm", { model: draftModel }).catch(() => {});
    if (files.length === 0 || draftRef.current?.key === changeKey) return;
    draftRef.current = {
      key: changeKey,
      result: draftMessage().then(
        (message) => ({ message }),
        (error: unknown) => ({ error })
      ),
    };
  }

  /** The prefetched draft when it still describes these changes, else a fresh
   *  one. A prefetch that failed is retried rather than reported: the click is
   *  the first moment the user is actually waiting on it. */
  async function draftForCommit(): Promise<string> {
    const pending = draftRef.current;
    if (pending?.key === changeKey) {
      const settled = await pending.result;
      if ("message" in settled) return settled.message;
    }
    return draftMessage();
  }

  /** What the next commit will contain. Staging is implicit: with nothing
   *  staged the whole working tree goes in, which is the common case here — the
   *  changes were made by an agent, not hand-picked. An explicit staging
   *  selection is left alone. */
  async function stageForCommit() {
    if (staged.length > 0 || unstaged.length === 0) return;
    await invoke("git_stage", {
      path: projectPath,
      files: unstaged.map((f) => f.path),
    });
  }

  /** Commit and push in one call: the Rust side runs its safety checks before
   *  committing, so a refusal never strands a commit. */
  async function commitAndPush(message: string): Promise<boolean> {
    let out = await invoke<CommitPush>("git_commit_and_push", {
      path: projectPath,
      message,
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
        message,
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
        description: subjectOf(message),
        action: readMore(url),
      });
    }
    return out.pushed;
  }

  async function push(): Promise<boolean> {
    if (branch!.upstream) {
      await invoke<string>("git_push", { path: projectPath });
    } else {
      await invoke<string>("git_push_to", {
        path: projectPath,
        remote: "origin",
        branch: branch!.branch,
      });
    }
    toast.success(`Pushed ${branch!.branch}`);
    return true;
  }

  async function openPullRequest(message: string) {
    const [title, ...rest] = message.trim().split("\n");
    const url = await invoke<string>("forge_pr_create", {
      path: projectPath,
      provider: forge,
      title: title || branch!.branch,
      body: rest.join("\n").trim(),
      base: defaultBranchQuery.data ?? null,
    });
    toast.success(`Opened ${noun}`, {
      description: subjectOf(message),
      action: readMore(url),
    });
  }

  async function run(action: { kind: GitActionKind; label: string }) {
    const { kind, label } = action;
    if (busy) return;
    // Nothing here can write a message without a model to write it with, and a
    // commit is not something to run with a placeholder subject.
    if (needsMessage(kind) && !draftModel) {
      toast.error("No commit-message model set", {
        description: "Pick one in Settings → General to commit from here.",
      });
      return;
    }
    // Pushing straight to the branch everything merges into is the one move
    // worth a second look; every other target is cheap to undo.
    if (pushes(kind) && state.isDefaultBranch) {
      const ok = await ask(
        `This will push to ${branch!.branch}, the default branch.`,
        { title: `${label} to default branch?`, kind: "warning" }
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      let pushed = true;
      let message = "";
      if (needsMessage(kind)) {
        // Draft first, stage second. `commit_diff` reads the index when
        // anything is staged and the working tree otherwise, so drafting after
        // staging describes a different diff than the one prefetched while the
        // menu opened — for a new file, its whole contents rather than its name.
        message = await draftForCommit();
        await stageForCommit();
      }
      if (kind === "commit") {
        await invoke<string>("git_commit", { path: projectPath, message });
        const url = await invoke<string | null>("git_head_commit_url", {
          path: projectPath,
        }).catch(() => null);
        toast.success("Committed", {
          description: subjectOf(message),
          action: readMore(url),
        });
      } else if (kind === "commitPush" || kind === "commitPushPr") {
        pushed = await commitAndPush(message);
      } else if (kind === "push" || kind === "pushPr") {
        pushed = await push();
      } else if (kind === "pull") {
        await invoke<string>("git_pull", { path: projectPath });
        toast.success("Pulled");
      }
      // A PR for a branch the remote never received would 404 — only open one
      // once the push actually landed.
      if (opensPr(kind) && pushed) await openPullRequest(message);
    } catch (e) {
      toast.error(`${label} failed`, { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) prefetch();
        else draftRef.current = null;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant={open ? "chromeActive" : "chrome"}
          size="sm"
          title="Commit, push, open a pull request"
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <GitCommitVertical className="size-3.5" />
          )}
          Commit &amp; push
          {staged.length + unstaged.length > 0 && (
            <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-400">
              {staged.length + unstaged.length}
            </span>
          )}
          {/* The label names one action, so without this the button reads as a
              button — the caret is what says the other moves are in here. */}
          <ChevronDown className="size-3 opacity-60" />
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
              onSelect={() => void run(action)}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
