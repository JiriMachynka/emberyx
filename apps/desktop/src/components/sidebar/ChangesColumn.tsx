import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Files,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
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
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { isStaged, isUnstaged } from "@/lib/gitStatus";
import { FORGE_NOUN, isRemoteHost, type RemoteHost } from "@/lib/forge";
import { loadSettings } from "@/lib/settings";
import {
  gitStatusInterval,
  useForgeCliStatus,
  useForgeOpenPr,
  useGitBranch,
  useGitChanges,
  useGitDefaultBranch,
  useInvalidateGit,
} from "@/lib/queries";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CommitPush, GitFile, Json } from "@/types";

/** Auto-resize cap for the commit-message textarea. */
const MESSAGE_MAX = 160;

/** VS Code-style line for a clean tree that's ahead/behind — the empty list's
 *  second line, matching what the sync row can do right now. */
const syncCopy = (branch: { ahead: number; behind: number }): string | null => {
  if (branch.behind === 0) {
    return branch.ahead === 0
      ? null
      : `${branch.ahead} unpushed commit${branch.ahead === 1 ? "" : "s"}`;
  }
  return branch.ahead === 0
    ? `${branch.behind} incoming commit${branch.behind === 1 ? "" : "s"}`
    : `Diverged with ${branch.ahead} ahead, ${branch.behind} behind`;
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

/** One file row: hover discard (unstaged only) + stage/unstage, status letter. */
function FileRow({
  file,
  staged,
  open,
  onPick,
  onToggle,
  onDiscard,
}: {
  file: GitFile;
  staged: boolean;
  open: boolean;
  onPick: () => void;
  onToggle: () => void;
  onDiscard: () => void;
}) {
  const letter = statusLetter(file);
  const dir = file.path.includes("/") ? dirname(file.path) : "";
  return (
    <li className="group/file flex items-center">
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent",
          open && "bg-accent text-foreground"
        )}
      >
        <FileTypeIcon path={file.path} />
        <span className="min-w-0 flex-1 truncate">
          {basename(file.path)}
          {dir && <span className="ml-1.5 text-muted-foreground">{dir}</span>}
        </span>
      </button>
      <span
        className={cn(
          "w-4 shrink-0 text-center font-mono text-3xs",
          statusColor(letter)
        )}
      >
        {letter}
      </span>
      <span className="flex items-center">
        <button
          type="button"
          title={staged ? "Unstage" : "Stage"}
          onClick={onToggle}
          className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover/file:opacity-100"
        >
          {staged ? <Minus className="size-3" /> : <Plus className="size-3" />}
        </button>
        {!staged && (
          <button
            type="button"
            title={file.untracked ? "Delete" : "Discard"}
            onClick={onDiscard}
            className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover/file:opacity-100"
          >
            <Undo2 className="size-3" />
          </button>
        )}
      </span>
    </li>
  );
}

/** One collapsible section of the file list with its header actions. */
function FileSection({
  title,
  count,
  files,
  actions,
  rows,
}: {
  title: string;
  count: number;
  files: GitFile[];
  actions: React.ReactNode;
  rows: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  if (files.length === 0) return null;
  return (
    <>
      <div className="flex items-center gap-1 px-3 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-0.5 hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          {title}
        </button>
        <span className="rounded bg-primary/15 px-1.5 tabular-nums text-primary">
          {count}
        </span>
        <span className="ml-auto flex items-center gap-0.5">{actions}</span>
      </div>
      {open && <ul className="px-1 pb-1">{rows}</ul>}
    </>
  );
}

/** Small round header button in a section row. */
function MiniButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** The branch as the Git panel's title: its name, and how far it sits from
 *  its upstream. Nothing until the branch read lands — a repo with no
 *  commits has no branch to name. */
export function BranchTitle({ projectPath }: { projectPath: string }) {
  const branch = useGitBranch(projectPath).data;
  if (!branch) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{branch.branch}</span>
      {branch.behind > 0 && (
        <span className="flex shrink-0 items-center text-xs font-normal tabular-nums text-muted-foreground">
          <ArrowDown className="size-3" />
          {branch.behind}
        </span>
      )}
      {branch.ahead > 0 && (
        <span className="flex shrink-0 items-center text-xs font-normal tabular-nums text-muted-foreground">
          <ArrowUp className="size-3" />
          {branch.ahead}
        </span>
      )}
    </span>
  );
}

export function ChangesColumn({
  projectPath,
  rightDock,
  remoteHost,
  active = true,
  onOpenReview,
}: {
  projectPath: string;
  rightDock: boolean;
  remoteHost: string | undefined;
  /** Visible tab: porcelain watch + forge probes. Hidden keep-alive only
   *  reads the shared git cache and warms the graph. */
  active?: boolean;
  onOpenReview: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [wandBusy, setWandBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const drafting = useRef(false);

  const branchQuery = useGitBranch(projectPath);
  const changesQuery = useGitChanges(
    projectPath,
    true,
    gitStatusInterval(active ? "watch" : "read")
  );
  const defaultBranchQuery = useGitDefaultBranch(projectPath);
  const forge = isRemoteHost(remoteHost ?? "") ? (remoteHost as RemoteHost) : undefined;
  const branch = branchQuery.data;
  const openPrQuery = useForgeOpenPr(projectPath, forge, branch?.branch, active);
  const cliStatus = useForgeCliStatus(active);
  const invalidateGit = useInvalidateGit();

  const files = changesQuery.data ?? [];
  const staged = useMemo(() => files.filter(isStaged), [files]);
  const unstaged = useMemo(() => files.filter(isUnstaged), [files]);
  const canOpenPr =
    !!forge && !!cliStatus.data?.find((c) => c.id === forge)?.authenticated;
  const noun = FORGE_NOUN[forge ?? "github"].one;

  // Stage-first: Commit writes the staged index only. A split item with an
  // empty message of a model-less draft falls through to the no-model error
  // path below.
  const canCommit = staged.length > 0;
  const hasMessage = message.trim() !== "";

  const draftMessage = () =>
    invoke<string>("git_draft_commit_message", {
      path: projectPath,
      model: loadSettings().commitMessageModel,
    });

  /** Wand: draft from the whole working tree into the message box. */
  const runWand = async () => {
    if (files.length === 0 || drafting.current) return;
    if (!loadSettings().commitMessageModel) {
      toast.error("No commit-message model set", {
        description: "Pick one in Settings → Source Control to draft messages.",
      });
      return;
    }
    drafting.current = true;
    setWandBusy(true);
    void invoke("draft_warm", { model: loadSettings().commitMessageModel }).catch(
      () => {}
    );
    try {
      setMessage(await draftMessage());
    } catch {
      // The box stays empty; commit will confirm the real error on click.
    } finally {
      drafting.current = false;
      setWandBusy(false);
    }
  };

  async function runGit(fn: () => Promise<Json | void>, fail: string) {
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

  /** Discard every unstaged file after one confirmation; untracked ones are
   *  deleted (their own flag), tracked ones checked out. */
  const discardAll = async () => {
    if (unstaged.length === 0) return;
    const noun = `file${unstaged.length === 1 ? "" : "s"}`;
    const ok = await ask(
      `Discard all changes to ${unstaged.length} ${noun}? This can't be undone.`,
      { title: "Discard all", kind: "warning" }
    );
    if (!ok) return;
    const tracked = unstaged.filter((f) => !f.untracked).map((f) => f.path);
    const untracked = unstaged.filter((f) => f.untracked).map((f) => f.path);
    await runGit(async () => {
      if (tracked.length) {
        await invoke("git_discard", {
          path: projectPath,
          files: tracked,
          untracked: false,
        });
      }
      if (untracked.length) {
        await invoke("git_discard", {
          path: projectPath,
          files: untracked,
          untracked: true,
        });
      }
    }, "Couldn't discard");
  };

  /** The message textarea grows with its content, capped. */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MESSAGE_MAX)}px`;
  }, [message]);

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

  const commitToast = async (subject: string) => {
    const url = await invoke<string | null>("git_head_commit_url", {
      path: projectPath,
    }).catch(() => null);
    toast.success("Committed", {
      description: subject,
      action: url
        ? { label: "Read more…", onClick: () => void openUrl(url) }
        : undefined,
    });
  };

  /** The user's message, or a fresh draft from the diff when a model is set. */
  const resolveMessage = async (): Promise<string> => {
    const text = message.trim();
    if (text) return text;
    if (!loadSettings().commitMessageModel) {
      toast.error("No commit-message model set", {
        description:
          "Write a message, or pick a model in Settings → Source Control.",
      });
      throw new Error("no message");
    }
    const drafted = await draftMessage();
    setMessage(drafted);
    return drafted;
  };

  /** The primary Commit, on the staged set as it stands. No implicit staging. */
  const commit = async () => {
    if (busy || !canCommit) return;
    setBusy(true);
    try {
      const text = await resolveMessage();
      await invoke<string>("git_commit", { path: projectPath, message: text });
      await commitToast(subjectOf(text));
      setMessage("");
    } catch {
      // Toasts already handled: resolveMessage owns the missing draft error.
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  };

  /** The split dropdown's run. This surface commits locally; Sync / Publish
   *  handle the push. */
  const runAction = async (kind: "commitPushPr" | "pushPr", label: string) => {
    if (busy || !branch) return;
    if (
      (kind === "commitPushPr" || kind === "pushPr") &&
      defaultBranchQuery.data === branch.branch
    ) {
      const ok = await ask(
        `This will push to ${branch.branch}, the default branch.`,
        { title: `${label} to default branch?`, kind: "warning" }
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      let pushed = true;
      if (kind === "commitPushPr") {
        const text = await resolveMessage();
        pushed = await commitAndPush(text);
        if (pushed) setMessage("");
      } else if (kind === "pushPr") {
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
      }
      if ((kind === "commitPushPr" || kind === "pushPr") && pushed) {
        const [title, ...rest] = message.trim().split("\n");
        const url = await invoke<string>("forge_pr_create", {
          path: projectPath,
          provider: forge,
          title: title || branch.branch,
          body: rest.join("\n").trim(),
          base: defaultBranchQuery.data ?? null,
        });
        toast.success(`Opened ${noun}`, {
          action: { label: "Read more…", onClick: () => void openUrl(url) },
        });
      }
    } catch (e) {
      toast.error(`${label} failed`, { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  };

  const publishBranch = async () => {
    if (!branch || busy) return;
    if (defaultBranchQuery.data === branch.branch) {
      const ok = await ask(
        `This will publish ${branch.branch}, the default branch, to origin.`,
        { title: "Publish branch?", kind: "warning" }
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await invoke<string>("git_push_to", {
        path: projectPath,
        remote: "origin",
        branch: branch.branch,
      });
      toast.success(`Published ${branch.branch}`);
    } catch (e) {
      toast.error("Publish failed", { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  };

  /** Pull, then push what remains — the one Sync Changes move. */
  const syncChanges = async () => {
    if (!branch || busy) return;
    setBusy(true);
    try {
      if (branch.behind > 0) {
        await invoke<string>("git_pull", { path: projectPath });
      }
      if (branch.ahead > 0) {
        if (defaultBranchQuery.data === branch.branch) {
          const ok = await ask(
            `This will push to ${branch.branch}, the default branch.`,
            { title: "Push to default branch?", kind: "warning" }
          );
          if (!ok) return;
        }
        await invoke<string>("git_push", { path: projectPath });
      }
      toast.success(
        branch.behind > 0 && branch.ahead > 0
          ? "Synced"
          : branch.ahead > 0
            ? `Pushed ${branch.branch}`
            : "Pulled"
      );
    } catch (e) {
      toast.error("Sync failed", { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  };

  const openPr = openPrQuery.data ?? null;
  // Off default, no open PR, and the forge can act: the offer exists even when
  // disabled — a control that appears only when ready moves under you.
  const prOfferExists =
    !!forge && canOpenPr && !!branch &&
    defaultBranchQuery.data !== branch.branch && !openPr;
  const canCreatePr =
    prOfferExists &&
    files.length === 0 &&
    branch!.ahead > 0 &&
    branch!.behind === 0;

  const createPr = async () => {
    if (!branch || busy || !canCreatePr) return;
    setBusy(true);
    try {
      const url = await invoke<string>("forge_pr_create", {
        path: projectPath,
        provider: forge,
        title: branch.branch,
        body: "",
        base: defaultBranchQuery.data ?? null,
      });
      toast.success(`Opened ${noun}`, {
        action: { label: "Read more…", onClick: () => void openUrl(url) },
      });
    } catch (e) {
      toast.error(`Opening ${noun} failed`, { description: String(e) });
    } finally {
      setBusy(false);
      invalidateGit(projectPath);
    }
  };

  const pickFile = (file: GitFile) => {
    setSelected(file.path);
    if (rightDock) onOpenReview();
  };

  const empty = files.length === 0;
  const changesPending = changesQuery.isPending && !changesQuery.data;
  const cleanNote = branch && empty && !changesPending ? syncCopy(branch) : null;
  // The split dropdown is the PR move only. Commit is the button; push is
  // Sync / Publish below.
  const canPush = !!branch && (branch.ahead > 0 || !branch.upstream);
  const prKind = canCommit && hasMessage ? "commitPushPr" : "pushPr";
  const dropdown: {
    kind: "commitPushPr" | "pushPr";
    label: string;
    reason?: string;
  }[] = [
    {
      kind: prKind,
      label: prKind === "commitPushPr" ? "Commit, push & open PR" : "Push & open PR",
      reason: !canPush
        ? "Nothing to push"
        : openPr
          ? "A pull request is already open"
          : !canOpenPr
            ? "No forge CLI signed in"
            : undefined,
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Commit composer */}
      <div className="grid shrink-0 gap-2 px-3 pb-2 pt-3">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onFocus={() => void runWand()}
            disabled={!canCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canCommit) void commit();
              }
            }}
            placeholder={
              canCommit ? "Message (⌘⏎ to commit)" : "Stage files to write a message"
            }
            className="min-h-9 bg-secondary/50 pr-8 text-xs shadow-none"
          />
          {message ? (
            <button
              type="button"
              title="Clear message"
              onClick={() => setMessage("")}
              className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              title="Draft a commit message from the diff"
              disabled={busy || wandBusy || files.length === 0}
              onClick={() => void runWand()}
              className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Sparkles className="size-3.5" />
            </button>
          )}
        </div>
        <div
          className={cn(
            "flex overflow-hidden rounded-lg",
            canCommit ? "bg-primary" : "bg-secondary",
          )}
        >
          <Button
            size="sm"
            variant={canCommit ? "default" : "secondary"}
            className="min-w-0 flex-1 rounded-none shadow-none disabled:opacity-100"
            disabled={busy || !canCommit}
            title={!canCommit ? "Stage something first" : undefined}
            onClick={() => void commit()}
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Commit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={canCommit ? "default" : "secondary"}
                disabled={busy}
                title="More commit actions"
                className={cn(
                  "rounded-none px-2 shadow-none disabled:opacity-100",
                  canCommit
                    ? "border-l border-primary-foreground/20"
                    : "border-l border-border",
                )}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {dropdown.map((action) => (
                  <DropdownMenuItem
                    key={action.kind}
                    disabled={busy || !!action.reason}
                    title={action.reason}
                    onSelect={() => void runAction(action.kind, action.label)}
                  >
                    <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                    {action.label}
                  </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {!canCommit && files.length > 0 && (
          <p className="text-2xs text-muted-foreground">
            Stage files to commit
          </p>
        )}
      </div>

      {/* Sync row — shown only when it can do something. */}
      {branch &&
        (!branch.upstream || branch.ahead > 0 || branch.behind > 0 || canCreatePr || openPr) && (
          <div className="flex shrink-0 items-center gap-1 px-3 py-1.5 text-xs">
            {!branch.upstream ? (
              <LaneButton onClick={() => void publishBranch()}>
                <ArrowUpFromLine className="size-3.5" />
                Publish Branch
              </LaneButton>
            ) : branch.ahead > 0 || branch.behind > 0 ? (
              <LaneButton onClick={() => void syncChanges()}>
                Sync Changes
                {branch.behind > 0 && (
                  <span className="flex shrink-0 items-center tabular-nums">
                    <ArrowDown className="size-3" />
                    {branch.behind}
                  </span>
                )}
                {branch.ahead > 0 && (
                  <span className="flex shrink-0 items-center tabular-nums">
                    <ArrowUp className="size-3" />
                    {branch.ahead}
                  </span>
                )}
              </LaneButton>
            ) : null}
            {canCreatePr && (
              <LaneButton onClick={() => void createPr()}>
                <GitPullRequest className="size-3.5" />
                Create PR
              </LaneButton>
            )}
            {openPr && (
              <LaneButton onClick={() => void openUrl(openPr)}>
                View PR
              </LaneButton>
            )}
          </div>
        )}

      {/* File lists. Empty stays a short note so the graph can fill the rest. */}
      <div
        className={cn(
          "overflow-auto pb-1",
          empty ? "shrink-0" : "min-h-0 flex-1",
        )}
      >
        {changesPending ? null : empty ? (
          <div className="pt-2">
            <p className="px-3 py-2 text-center text-xs text-muted-foreground">
              No uncommitted changes
            </p>
            {cleanNote && (
              <p className="px-3 pb-2 text-center text-2xs text-muted-foreground">
                {cleanNote}
              </p>
            )}
          </div>
        ) : (
          <>
            <FileSection
              title="Staged Changes"
              count={staged.length}
              files={staged}
              actions={
                <>
                  <MiniButton
                    title="Stage all"
                    disabled={unstaged.length === 0}
                    onClick={() => void stage(unstaged.map((f) => f.path))}
                  >
                    <Plus className="size-3" />
                  </MiniButton>
                  <MiniButton
                    title="Unstage all"
                    onClick={() => void unstage(staged.map((f) => f.path))}
                  >
                    <Minus className="size-3" />
                  </MiniButton>
                </>
              }
              rows={staged.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  staged
                  open={selected === file.path}
                  onPick={() => pickFile(file)}
                  onToggle={() => void unstage([file.path])}
                  onDiscard={() => void discardFile(file)}
                />
              ))}
            />
            <FileSection
              title="Changes"
              count={unstaged.length}
              files={unstaged}
              actions={
                <>
                  <MiniButton
                    title="Discard all"
                    onClick={() => void discardAll()}
                  >
                    <Trash2 className="size-3" />
                  </MiniButton>
                  <MiniButton
                    title="Stage all"
                    onClick={() => void stage(unstaged.map((f) => f.path))}
                  >
                    <Plus className="size-3" />
                  </MiniButton>
                  <MiniButton
                    title="Open all"
                    disabled={!rightDock}
                    onClick={onOpenReview}
                  >
                    <Files className="size-3" />
                  </MiniButton>
                </>
              }
              rows={unstaged.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  staged={false}
                  open={selected === file.path}
                  onPick={() => pickFile(file)}
                  onToggle={() => void stage([file.path])}
                  onDiscard={() => void discardFile(file)}
                />
              ))}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** The quiet wide button of the sync row. */
function LaneButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="min-w-0 flex-1 justify-start"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
