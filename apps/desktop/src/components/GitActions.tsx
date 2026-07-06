import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import type { GitBranch, GitStash } from "@/types";

interface GitActionsProps {
  projectPath: string;
  /** Bumped by the parent whenever the working tree is reloaded. */
  reloadKey: number;
  /** Re-fetch the working-tree change list after an operation. */
  onRefresh: () => void;
}

/** Inline prompt to gather one text value (new branch name / remote name). */
type Prompt =
  | { kind: "new-branch"; label: string; placeholder: string; value: string }
  | { kind: "push-to"; label: string; placeholder: string; value: string }
  | null;

/** Branch bar + pull/push/checkout/stash actions for the current repo. */
export function GitActions({ projectPath, reloadKey, onRefresh }: GitActionsProps) {
  const [branch, setBranch] = useState<GitBranch | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);

  const reloadBranch = useCallback(() => {
    invoke<GitBranch>("git_branch", { path: projectPath })
      .then(setBranch)
      .catch(() => setBranch(null)); // Not a repo / no commits yet.
  }, [projectPath]);

  useEffect(() => {
    reloadBranch();
  }, [reloadBranch, reloadKey]);

  /** Run a git op, toast the outcome, then refresh branch + change list. */
  async function run(label: string, op: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    try {
      const out = await op();
      toast.success(label, out ? { description: out } : undefined);
      reloadBranch();
      onRefresh();
    } catch (e) {
      toast.error(`${label} failed`, { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!branch) return null;

  const { upstream, ahead, behind } = branch;

  function submitPrompt() {
    if (!prompt) return;
    const value = prompt.value.trim();
    if (!value) return;
    if (prompt.kind === "new-branch") {
      run("Created branch", () =>
        invoke<string>("git_checkout", { path: projectPath, branch: value, create: true })
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

        <DropdownMenu onOpenChange={(open) => open && loadBranches(projectPath, setBranches)}>
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
          <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-auto">
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
            {branches.map((b) => (
              <DropdownMenuItem
                key={b}
                disabled={b === branch.branch}
                onSelect={() =>
                  run("Checked out", () =>
                    invoke<string>("git_checkout", { path: projectPath, branch: b, create: false })
                  )
                }
              >
                {b === branch.branch && <Check className="size-4" />}
                <span className={cn("truncate", b === branch.branch && "font-medium")}>{b}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu onOpenChange={(open) => open && loadStashes(projectPath, setStashes)}>
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
          <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-auto">
            <DropdownMenuItem
              onSelect={() =>
                run("Stashed", () =>
                  invoke<string>("git_stash_push", { path: projectPath, message: "" })
                )
              }
            >
              <Archive className="size-4" />
              Stash changes
            </DropdownMenuItem>
            {stashes.length > 0 && <DropdownMenuSeparator />}
            {stashes.map((s) => (
              <div key={s.index} className="px-2 py-1.5">
                <div className="truncate text-xs text-muted-foreground" title={s.label}>
                  {s.label}
                </div>
                <div className="mt-1 flex gap-2 text-[11px]">
                  <button
                    className="text-emerald-400 hover:underline"
                    onClick={() =>
                      run("Popped stash", () =>
                        invoke<string>("git_stash_apply", { path: projectPath, index: s.index, pop: true })
                      )
                    }
                  >
                    Pop
                  </button>
                  <button
                    className="text-sky-400 hover:underline"
                    onClick={() =>
                      run("Applied stash", () =>
                        invoke<string>("git_stash_apply", { path: projectPath, index: s.index, pop: false })
                      )
                    }
                  >
                    Apply
                  </button>
                  <button
                    className="text-red-400 hover:underline"
                    onClick={() =>
                      run("Dropped stash", () =>
                        invoke<string>("git_stash_drop", { path: projectPath, index: s.index })
                      )
                    }
                  >
                    Drop
                  </button>
                </div>
              </div>
            ))}
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

function loadBranches(path: string, set: (b: string[]) => void) {
  invoke<string[]>("git_branches", { path }).then(set).catch(() => set([]));
}

function loadStashes(path: string, set: (s: GitStash[]) => void) {
  invoke<GitStash[]>("git_stash_list", { path }).then(set).catch(() => set([]));
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
