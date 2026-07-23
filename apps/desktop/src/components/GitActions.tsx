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
  Archive,
  Check,
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
} from "@/components/ui/dropdown-menu";
import { useGitBranch, useGitBranches, useGitStashes, useInvalidateGit } from "@/lib/queries";

interface GitActionsProps {
  projectPath: string;
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
  | null;

/** Branch bar + pull/push/checkout/stash actions for the current repo. */
export function GitActions({ projectPath }: GitActionsProps) {
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [stashesOpen, setStashesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);

  const branchQuery = useGitBranch(projectPath);
  const branchesQuery = useGitBranches(projectPath, branchesOpen);
  const stashesQuery = useGitStashes(projectPath, stashesOpen);
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
            <DropdownMenuItem
              onSelect={() =>
                setPrompt({
                  kind: "new-branch",
                  label: "New branch name:",
                  placeholder: "feature/…",
                  value: "",
                })
              }
            >
              <GitBranchPlus className="size-4" />
              New branch…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Checkout</DropdownMenuLabel>
            {(branchesQuery.data ?? []).map((b) => {
              const isCurrent = b === branch.branch;
              return (
                <div key={b} className="flex items-center px-1">
                  <button
                    disabled={isCurrent}
                    onClick={() =>
                      run("Checked out", () =>
                        invoke<string>("git_checkout", { path: projectPath, branch: b, create: false })
                      )
                    }
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                      isCurrent
                        ? "font-medium disabled:pointer-events-none"
                        : "hover:bg-accent"
                    )}
                  >
                    {isCurrent && <Check className="size-4 shrink-0" />}
                    <span className="truncate">{b}</span>
                  </button>
                  {!isCurrent && (
                    <button
                      onClick={() => confirmDeleteBranch(b)}
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
