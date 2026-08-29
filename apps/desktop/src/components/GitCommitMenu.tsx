import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { ChevronDown, GitCommitVertical, LoaderCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { isStaged, isUnstaged } from "@/lib/gitStatus";
import {
  menuActions,
  needsMessage,
  opensPr,
  primaryAction,
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

interface GitCommitMenuProps {
  projectPath: string;
  /** Which forge the origin remote is on; undefined for a repo without one. */
  remoteHost: string | undefined;
}

/**
 * Commit / push / open-PR from the top bar, without opening the changes panel.
 *
 * The primary button is whatever the repo's state calls for next rather than a
 * fixed "Commit" — see `lib/gitAction.ts`. Everything the state allows stays in
 * the split menu, so the adaptation shortens the common path without hiding an
 * action.
 */
export function GitCommitMenu({ projectPath, remoteHost }: GitCommitMenuProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  // Read once on mount, not per render: this menu lives in the top bar, which
  // re-renders often, and `loadSettings` parses and migrates the whole blob.
  const [draftModel] = useState(() => loadSettings().commitMessageModel);

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
  const primary = primaryAction(state);
  const others = menuActions(state);
  const noun = FORGE_NOUN[forge ?? "github"].one;

  /** Draft the message from the diff and drop it in the box — never commit it.
   *  Whatever comes back is a suggestion the user reads and edits. */
  async function draft() {
    if (drafting || busy) return;
    setDrafting(true);
    try {
      const drafted = await invoke<string>("git_draft_commit_message", {
        path: projectPath,
        model: draftModel,
      });
      setMessage(drafted);
    } catch (e) {
      toast.error("Couldn't draft a message", { description: String(e) });
    } finally {
      setDrafting(false);
    }
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
  async function commitAndPush(): Promise<boolean> {
    let out = await invoke<CommitPush>("git_commit_and_push", {
      path: projectPath,
      message: message.trim(),
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
        message: message.trim(),
        setUpstream: true,
      });
    }
    if (out.committed && !out.pushed) {
      toast.warning("Committed, but not pushed", { description: out.message });
      return false;
    }
    if (out.pushed) toast.success(`Pushed to ${out.branch}`);
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

  async function openPullRequest() {
    const [title, ...rest] = message.trim().split("\n");
    const url = await invoke<string>("forge_pr_create", {
      path: projectPath,
      provider: forge,
      title: title || branch!.branch,
      body: rest.join("\n").trim(),
      base: defaultBranchQuery.data ?? null,
    });
    toast.success(`Opened ${noun}`, { description: url });
  }

  async function run(kind: GitActionKind) {
    if (busy) return;
    if (needsMessage(kind) && !message.trim()) {
      toast.error("Write a commit message first");
      return;
    }
    // Pushing straight to the branch everything merges into is the one move
    // worth a second look; every other target is cheap to undo.
    if (pushes(kind) && state.isDefaultBranch) {
      const ok = await ask(
        `This will push to ${branch!.branch}, the default branch.`,
        { title: `${primary.label} to default branch?`, kind: "warning" }
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      let pushed = true;
      if (needsMessage(kind)) await stageForCommit();
      if (kind === "commit") {
        await invoke<string>("git_commit", {
          path: projectPath,
          message: message.trim(),
        });
        toast.success("Committed");
      } else if (kind === "commitPush" || kind === "commitPushPr") {
        pushed = await commitAndPush();
      } else if (kind === "push" || kind === "pushPr") {
        pushed = await push();
      } else if (kind === "pull") {
        await invoke<string>("git_pull", { path: projectPath });
        toast.success("Pulled");
      }
      // A PR for a branch the remote never received would 404 — only open one
      // once the push actually landed.
      if (opensPr(kind) && pushed) await openPullRequest();
      if (needsMessage(kind)) setMessage("");
      setOpen(false);
    } catch (e) {
      toast.error(`${primary.label} failed`, { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={open ? "secondary" : "ghost"} size="sm" title="Commit, push, open a pull request">
          <GitCommitVertical className="size-3.5" />
          Commit
          {staged.length + unstaged.length > 0 && (
            <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-400">
              {staged.length + unstaged.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={branch.upstream ?? "no upstream"}>
            {branch.branch}
            {state.isDefaultBranch && " · default"}
          </span>
          <span>
            {staged.length > 0
              ? `${staged.length} staged${
                  unstaged.length > 0 ? ` · ${unstaged.length} unstaged` : ""
                }`
              : `${unstaged.length} ${unstaged.length === 1 ? "change" : "changes"}`}
          </span>
        </div>

        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          rows={3}
          className="mb-2 resize-none text-sm"
        />

        <div className="flex items-center gap-2">
          {draftModel && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || drafting || files.length === 0}
              title={
                files.length === 0
                  ? "Nothing to describe"
                  : "Draft a message from the diff"
              }
              onClick={() => void draft()}
            >
              {drafting ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Generate
            </Button>
          )}

          <Button
            className="flex-1"
            size="sm"
            disabled={busy || drafting || !!primary.disabledReason}
            title={primary.disabledReason}
            onClick={() => run(primary.kind)}
          >
            {busy && <LoaderCircle className="size-3.5 animate-spin" />}
            {primary.label}
          </Button>

          {others.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" disabled={busy} title="More actions">
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {others.map((action) => (
                  <DropdownMenuItem
                    key={action.kind}
                    disabled={!!action.disabledReason}
                    title={action.disabledReason}
                    onSelect={() => void run(action.kind)}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
