import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  GitBranch as GitBranchIcon,
  ArrowDown,
  ArrowUp,
  ArrowDownToLine,
  ArrowUpFromLine,
  GitBranchPlus,
  GitFork,
  Archive,
  Check,
  Ellipsis,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  useGitBranch,
  useGitBranches,
  useGitRepoRoot,
  useGitStashes,
  useGitWorktrees,
  useInvalidateGit,
} from "@/lib/queries";

interface GitActionsProps {
  projectPath: string;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
  /** Changes column: one compact `⋯` menu (Pull + the three submenus) instead
   *  of the visible button row. The Git dock keeps its chrome. */
  compact?: boolean;
}

/** `stash@{0}: On main: message` / `stash@{0}: WIP on main: abc123 subject`
 *  → the branch and the message, for a readable stash row. */
function parseStash(label: string): { branch: string; message: string } {
  const m = /^stash@\{\d+\}:\s*(?:WIP on|On)\s+([^:]+):\s*(.*)$/i.exec(label);
  return m
    ? { branch: m[1].trim(), message: m[2].trim() }
    : { branch: "", message: label };
}

/** Inline prompt to gather one text value (new branch / remote / stash name). */
type Prompt =
  | { kind: "new-branch"; label: string; placeholder: string; value: string }
  | { kind: "push-to"; label: string; placeholder: string; value: string }
  | { kind: "stash"; label: string; placeholder: string; value: string }
  | { kind: "worktree"; label: string; placeholder: string; value: string }
  | null;

/** Branch bar + pull/push/checkout/stash/worktree actions for the current repo.
 *  Full chrome in the Git dock; a single overflow menu in the Changes column. */
export function GitActions({
  projectPath,
  onOpenWorktree,
  onRemoveWorktree,
  compact = false,
}: GitActionsProps) {
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [stashesOpen, setStashesOpen] = useState(false);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);

  const branchQuery = useGitBranch(projectPath);
  // The worktree menu needs the branch list too, to tell "checkout existing"
  // from "create new" when adding a worktree.
  const branchesQuery = useGitBranches(projectPath, branchesOpen || worktreesOpen);
  const stashesQuery = useGitStashes(projectPath, stashesOpen);
  // The branch menu greys out branches already checked out in a worktree.
  const worktreesQuery = useGitWorktrees(projectPath, worktreesOpen || branchesOpen);
  const repoRootQuery = useGitRepoRoot(projectPath);
  const invalidateGit = useInvalidateGit();

  /** Run a git op, toast the outcome, then refresh branch + change list. */
  async function run(label: string, op: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    try {
      const out = await op();
      toast.success(label, out ? { description: out } : undefined);
      invalidateGit(projectPath);
    } catch (e) {
      toast.error(`${label} failed`, { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!branchQuery.data) return null;

  const branch = branchQuery.data;
  const { upstream, ahead, behind } = branch;
  const branches = branchesQuery.data ?? [];
  const worktrees = worktreesQuery.data ?? [];
  // Worktrees are always managed from the main checkout — git refuses to add or
  // remove them from a linked worktree path.
  const mainRoot = repoRootQuery.data?.mainRoot ?? projectPath;
  // A branch checked out elsewhere can't be checked out here.
  const usedBy = new Map(
    worktrees.filter((w) => w.path !== projectPath && w.branch).map((w) => [w.branch, w.path])
  );

  /** Add a worktree for `name`, creating the branch when it doesn't exist yet,
   *  and open it as its own project. */
  async function addWorktree(name: string) {
    if (busy) return;
    setBusy(true);
    try {
      const path = await invoke<string>("git_worktree_add", {
        path: mainRoot,
        branch: name,
        create: !branches.includes(name),
        base: null,
      });
      onOpenWorktree(path, mainRoot, name);
      invalidateGit(projectPath, mainRoot);
      toast.success("Created worktree", {
        description: `${path} — tracked files only (no node_modules or .env) and no prior Claude thread history.`,
      });
    } catch (e) {
      toast.error("Create worktree failed", { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** Teardown, confirmation and toasts live in the workspace handler. */
  async function dropWorktree(worktreePath: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onRemoveWorktree(worktreePath, mainRoot);
      invalidateGit(projectPath, mainRoot);
    } finally {
      setBusy(false);
    }
  }

  /** Worktrees deleted outside the app linger in git's registry until pruned. */
  async function openWorktrees(open: boolean) {
    setWorktreesOpen(open);
    if (!open) return;
    try {
      await invoke("git_worktree_prune", { path: mainRoot });
      await worktreesQuery.refetch();
    } catch (e) {
      toast.error("Prune worktrees failed", { description: String(e) });
    }
  }

  /** Deleting a branch can discard unmerged work — confirm before doing it.
   *  Git itself still refuses (`-d`) if the branch isn't merged. */
  async function confirmDeleteBranch(name: string) {
    const ok = await ask(
      `Delete the branch "${name}"?\n\nOnly merged branches can be deleted this way.`,
      { title: "Delete branch", kind: "warning" }
    );
    if (!ok) return;
    run("Deleted branch", () =>
      invoke<string>("git_branch_delete", { path: projectPath, branch: name })
    );
  }

  /** Dropping a stash is unrecoverable — confirm before discarding it. */
  async function confirmDropStash(index: number, branch: string, message: string) {
    const label = branch ? `${branch} • ${message}` : message;
    const ok = await ask(
      `Delete this stash? Its changes are discarded permanently.\n\n${label}`,
      { title: "Delete stash", kind: "warning" }
    );
    if (!ok) return;
    run("Dropped stash", () =>
      invoke<string>("git_stash_drop", { path: projectPath, index })
    );
  }

  function submitPrompt() {
    if (!prompt) return;
    const value = prompt.value.trim();
    if (!value) return;
    if (prompt.kind === "new-branch") {
      run("Created branch", () =>
        invoke<string>("git_checkout", { path: projectPath, branch: value, create: true })
      );
    } else if (prompt.kind === "worktree") {
      void addWorktree(value);
    } else if (prompt.kind === "stash") {
      run("Stashed", () =>
        invoke<string>("git_stash_push", { path: projectPath, message: value })
      );
    } else {
      // Push current branch to the named remote and set it as upstream.
      run("Pushed", () =>
        invoke<string>("git_push_to", {
          path: projectPath,
          remote: value,
          branch: branch!.branch,
        })
      );
    }
    setPrompt(null);
  }

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Branch, stash, worktree"
            className="rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            <Ellipsis className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={busy || !upstream}
            title={upstream ? `Pull from ${upstream}` : "No upstream to pull from"}
            onSelect={() =>
              run("Pulled", () => invoke<string>("git_pull", { path: projectPath }))
            }
          >
            <ArrowDownToLine className="size-3.5 shrink-0 text-muted-foreground" />
            Pull
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* The three submenus reuse the dock menu content verbatim — the
              item JSX is shared with the full chrome below. */}
          <DropdownMenuSub open={branchesOpen} onOpenChange={setBranchesOpen}>
            <DropdownMenuSubTrigger className="text-xs">
              <GitBranchPlus className="mr-2 size-3.5 text-muted-foreground" />
              Branch
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-72 overflow-auto">
              {branchMenuItems({
                branches,
                current: branch.branch,
                usedBy,
                onNewBranch: () =>
                  setPrompt({
                    kind: "new-branch",
                    label: "New branch name:",
                    placeholder: "feature/…",
                    value: "",
                  }),
                onCheckout: (b) =>
                  run("Checked out", () =>
                    invoke<string>("git_checkout", {
                      path: projectPath,
                      branch: b,
                      create: false,
                    })
                  ),
                onDelete: confirmDeleteBranch,
              })}
              {prompt?.kind === "new-branch" && (
                <PromptRow prompt={prompt} onDone={submitPrompt} onCancel={() => setPrompt(null)} syncValue={(v) => setPrompt({ ...prompt, value: v })} />
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub open={stashesOpen} onOpenChange={setStashesOpen}>
            <DropdownMenuSubTrigger className="text-xs">
              <Archive className="mr-2 size-3.5 text-muted-foreground" />
              Stash
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-96 overflow-auto">
              <DropdownMenuItem
                onSelect={() =>
                  setPrompt({
                    kind: "stash",
                    label: "Stash name",
                    placeholder: "Stash name…",
                    value: "",
                  })
                }
              >
                <Archive className="size-4" />
                Stash changes…
              </DropdownMenuItem>
              {(stashesQuery.data ?? []).length > 0 && <DropdownMenuSeparator />}
              {(stashesQuery.data ?? []).map((s) => {
                const parsed = parseStash(s.label);
                return (
                  <StashRow
                    key={s.index}
                    branch={parsed.branch}
                    message={parsed.message}
                    onApply={() =>
                      run("Popped stash", () =>
                        invoke<string>("git_stash_apply", {
                          path: projectPath,
                          index: s.index,
                          pop: true,
                        })
                      )
                    }
                    onDrop={() => confirmDropStash(s.index, parsed.branch, parsed.message)}
                  />
                );
              })}
              {prompt?.kind === "stash" && (
                <PromptRow prompt={prompt} onDone={submitPrompt} onCancel={() => setPrompt(null)} syncValue={(v) => setPrompt({ ...prompt, value: v })} />
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub open={worktreesOpen} onOpenChange={(o) => void openWorktrees(o)}>
            <DropdownMenuSubTrigger className="text-xs">
              <GitFork className="mr-2 size-3.5 text-muted-foreground" />
              Worktree
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-96 overflow-auto">
              <DropdownMenuItem
                onSelect={() =>
                  setPrompt({
                    kind: "worktree",
                    label: "Worktree branch name:",
                    placeholder: "feature/…",
                    value: "",
                  })
                }
              >
                <GitFork className="size-4" />
                New worktree…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Worktrees</DropdownMenuLabel>
              {worktrees.map((w) => (
                <WorktreeRow
                  key={w.path}
                  worktree={w}
                  current={w.path === projectPath}
                  onOpen={() => onOpenWorktree(w.path, mainRoot, w.branch)}
                  onDrop={() => void dropWorktree(w.path)}
                />
              ))}
              {prompt?.kind === "worktree" && (
                <PromptRow prompt={prompt} onDone={submitPrompt} onCancel={() => setPrompt(null)} syncValue={(v) => setPrompt({ ...prompt, value: v })} />
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={upstream ?? "no upstream"}>
          {branch.branch}
        </span>
        {(ahead > 0 || behind > 0) && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {behind > 0 && (
              <span className="flex items-center">
                <ArrowDown className="size-3" />
                {behind}
              </span>
            )}
            {ahead > 0 && (
              <span className="flex items-center">
                <ArrowUp className="size-3" />
                {ahead}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 px-2 pb-1.5">
        <ActionButton
          icon={<ArrowDownToLine className="size-3.5" />}
          label="Pull"
          disabled={busy || !upstream}
          title={upstream ? `Pull from ${upstream}` : "No upstream to pull from"}
          onClick={() => run("Pulled", () => invoke<string>("git_pull", { path: projectPath }))}
        />

        {upstream ? (
          <ActionButton
            icon={<ArrowUpFromLine className="size-3.5" />}
            label="Push"
            disabled={busy}
            title={`Push to ${upstream}`}
            onClick={() => run("Pushed", () => invoke<string>("git_push", { path: projectPath }))}
          />
        ) : (
          <ActionButton
            icon={<ArrowUpFromLine className="size-3.5" />}
            label="Push to…"
            disabled={busy}
            title="Push and set upstream"
            onClick={() =>
              setPrompt({
                kind: "push-to",
                label: `Remote to push ${branch.branch} to:`,
                placeholder: "origin",
                value: "origin",
              })
            }
          />
        )}

        <DropdownMenu onOpenChange={setBranchesOpen}>
          <DropdownMenuTrigger asChild>
            <span>
              <ActionButton
                icon={<GitBranchPlus className="size-3.5" />}
                label="Branch"
                disabled={busy}
                title="Checkout or create a branch"
                as="span"
              />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-auto">
            {branchMenuItems({
              branches,
              current: branch.branch,
              usedBy,
              onNewBranch: () =>
                setPrompt({
                  kind: "new-branch",
                  label: "New branch name:",
                  placeholder: "feature/…",
                  value: "",
                }),
              onCheckout: (b) =>
                run("Checked out", () =>
                  invoke<string>("git_checkout", { path: projectPath, branch: b, create: false })
                ),
              onDelete: confirmDeleteBranch,
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu onOpenChange={setStashesOpen}>
          <DropdownMenuTrigger asChild>
            <span>
              <ActionButton
                icon={<Archive className="size-3.5" />}
                label="Stash"
                disabled={busy}
                title="Stash changes"
                as="span"
              />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-96 overflow-auto">
            <DropdownMenuItem
              onSelect={() =>
                setPrompt({
                  kind: "stash",
                  label: "Stash name",
                  placeholder: "Stash name…",
                  value: "",
                })
              }
            >
              <Archive className="size-4" />
              Stash changes…
            </DropdownMenuItem>
            {(stashesQuery.data ?? []).length > 0 && <DropdownMenuSeparator />}
            {(stashesQuery.data ?? []).map((s) => {
              const { branch, message } = parseStash(s.label);
              return (
              <div key={s.index} className="flex items-center gap-1.5 px-2 py-1.5">
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {branch && (
                  <>
                    <span className="shrink-0 text-xs font-medium">{branch}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">•</span>
                  </>
                )}
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={message}
                >
                  {message}
                </span>
                <button
                  className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-emerald-400"
                  onClick={() =>
                    run("Popped stash", () =>
                      invoke<string>("git_stash_apply", { path: projectPath, index: s.index, pop: true })
                    )
                  }
                >
                  <ArrowUpFromLine className="size-4" />
                </button>
                <button
                  className="ml-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-400"
                  onClick={() => confirmDropStash(s.index, branch, message)}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu onOpenChange={(open) => void openWorktrees(open)}>
          <DropdownMenuTrigger asChild>
            <span>
              <ActionButton
                icon={<GitFork className="size-3.5" />}
                label="Worktree"
                disabled={busy}
                title="Open or create a worktree"
                as="span"
              />
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-96 overflow-auto">
            <DropdownMenuItem
              onSelect={() =>
                setPrompt({
                  kind: "worktree",
                  label: "Worktree branch name:",
                  placeholder: "feature/…",
                  value: "",
                })
              }
            >
              <GitFork className="size-4" />
              New worktree…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Worktrees</DropdownMenuLabel>
            {worktrees.map((w) => {
              const isCurrent = w.path === projectPath;
              return (
                <div key={w.path} className="flex items-center px-1">
                  <button
                    onClick={() => onOpenWorktree(w.path, mainRoot, w.branch)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      isCurrent && "font-medium",
                      w.prunable && "text-muted-foreground"
                    )}
                    title={w.path}
                  >
                    {isCurrent && <Check className="size-4 shrink-0" />}
                    <span className="truncate">{w.branch || w.head}</span>
                    {(w.isMain || w.prunable) && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {w.isMain ? "main" : "missing"}
                      </span>
                    )}
                  </button>
                  {!w.isMain && (
                    <button
                      onClick={() => void dropWorktree(w.path)}
                      className="ml-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {prompt && (
        <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
          <Input
            autoFocus
            value={prompt.value}
            placeholder={prompt.placeholder}
            onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPrompt();
              if (e.key === "Escape") setPrompt(null);
            }}
            className="h-7 text-xs"
          />
          <button
            onClick={submitPrompt}
            disabled={!prompt.value.trim()}
            className="rounded p-1 text-emerald-400 hover:bg-accent disabled:opacity-40"
            title="Confirm"
          >
            <Check className="size-4" />
          </button>
          <button
            onClick={() => setPrompt(null)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Cancel"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Branch list shared by the dock chrome and the compact submenu. Kept as a
 *  function over its data rather than a component, so both call sites render
 *  exactly the same rows (a menu whose two homes differ has to be read twice). */
function branchMenuItems({
  branches,
  current,
  usedBy,
  onNewBranch,
  onCheckout,
  onDelete,
}: {
  branches: string[];
  current: string;
  usedBy: Map<string, string>;
  onNewBranch: () => void;
  onCheckout: (branch: string) => void;
  onDelete: (branch: string) => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onNewBranch}>
        <GitBranchPlus className="size-4" />
        New branch…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Checkout</DropdownMenuLabel>
      {branches.map((b) => {
        const isCurrent = b === current;
        const elsewhere = usedBy.get(b);
        return (
          <div key={b} className="flex items-center px-1">
            <button
              disabled={isCurrent || !!elsewhere}
              title={elsewhere}
              onClick={() => onCheckout(b)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                isCurrent
                  ? "font-medium disabled:pointer-events-none"
                  : elsewhere
                    ? "disabled:pointer-events-none disabled:opacity-50"
                    : "hover:bg-accent"
              )}
            >
              {isCurrent && <Check className="size-4 shrink-0" />}
              <span className="truncate">{b}</span>
              {elsewhere && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  in worktree
                </span>
              )}
            </button>
            {!isCurrent && (
              <button
                onClick={() => onDelete(b)}
                className="ml-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-400"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Branch list shared by the dock chrome and the compact submenu. */
export { branchMenuItems };

function ActionButton({
  icon,
  label,
  disabled,
  title,
  onClick,
  as = "button",
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  /** Render as a non-button span when used inside a dropdown trigger. */
  as?: "button" | "span";
}) {
  const className = cn(
    "flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
    disabled && "pointer-events-none opacity-40"
  );
  if (as === "span") {
    return (
      <span className={className} title={title}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <button className={className} disabled={disabled} title={title} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

/** One stash row in the compact submenu: branch • message, pop and drop. */
function StashRow({
  branch,
  message,
  onApply,
  onDrop,
}: {
  branch: string;
  message: string;
  onApply: () => void;
  onDrop: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      {branch && (
        <>
          <span className="shrink-0 text-xs font-medium">{branch}</span>
          <span className="shrink-0 text-xs text-muted-foreground">•</span>
        </>
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={message}>
        {message}
      </span>
      <button
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-emerald-400"
        onClick={onApply}
      >
        <ArrowUpFromLine className="size-4" />
      </button>
      <button
        className="ml-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-400"
        onClick={onDrop}
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

/** One worktree row in the compact submenu. */
function WorktreeRow({
  worktree,
  current,
  onOpen,
  onDrop,
}: {
  worktree: { path: string; branch: string; head: string; isMain: boolean; prunable: boolean };
  current: boolean;
  onOpen: () => void;
  onDrop: () => void;
}) {
  return (
    <div className="flex items-center px-1">
      <button
        onClick={onOpen}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
          current && "font-medium",
          worktree.prunable && "text-muted-foreground"
        )}
        title={worktree.path}
      >
        {current && <Check className="size-4 shrink-0" />}
        <span className="truncate">{worktree.branch || worktree.head}</span>
        {(worktree.isMain || worktree.prunable) && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {worktree.isMain ? "main" : "missing"}
          </span>
        )}
      </button>
      {!worktree.isMain && (
        <button
          onClick={onDrop}
          className="ml-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-400"
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}

/** The inline text row a compact submenu prompt renders. Lives inside the
 *  submenu so a new branch/stash/worktree name is entered where it was asked;
 *  each keystroke also lands in the shared prompt object the hub's
 *  `submitPrompt` reads, so Enter confirms the typed value. */
function PromptRow({
  prompt,
  onDone,
  onCancel,
  syncValue,
}: {
  prompt: { kind: string; value: string; placeholder: string };
  onDone: () => void;
  onCancel: () => void;
  /** Each keystroke lands in the shared prompt object the hub's
   *  `submitPrompt` reads, so Enter confirms the typed value. */
  syncValue: (text: string) => void;
}) {
  const [value, setValue] = useState(prompt.value);
  const sync = (text: string) => {
    setValue(text);
    syncValue(text);
  };
  return (
    <div className="flex items-center gap-1.5 border-t p-1">
      <Input
        autoFocus
        value={value}
        placeholder={prompt.placeholder}
        onChange={(e) => sync(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onDone();
          if (e.key === "Escape") onCancel();
        }}
        className="h-7 text-xs"
      />
      <button
        onClick={() => value.trim() && onDone()}
        disabled={!value.trim()}
        className="rounded p-1 text-emerald-400 hover:bg-accent disabled:opacity-40"
        title="Confirm"
      >
        <Check className="size-4" />
      </button>
      <button
        onClick={onCancel}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Cancel"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
