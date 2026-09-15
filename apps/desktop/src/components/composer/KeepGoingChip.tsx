import { memo } from "react";
import { Check, ChevronDown, Repeat } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chipTrigger } from "@/components/composer/chipStyles";
import {
  DEFAULT_MAX_TURNS,
  isKeepGoingOn,
  startKeepGoing,
  type KeepGoing,
} from "@/lib/keepGoing";
import type { GitFile, GitRepoRoot } from "@/types";

const TURN_CAPS = [
  { maxTurns: 20, label: "20 turns" },
  { maxTurns: 50, label: "50 turns" },
  { maxTurns: 0, label: "No turn cap" },
] as const;

const USD_CAPS = [
  { maxUsd: undefined, label: "No $ cap" },
  { maxUsd: 2, label: "$2" },
  { maxUsd: 10, label: "$10" },
  { maxUsd: 25, label: "$25" },
] as const;

interface KeepGoingChipProps {
  flag: KeepGoing | undefined;
  usage: { costUsd?: number };
  cwd: string;
  onChange: (next: KeepGoing | undefined) => void;
  onStop: () => void;
  onAccessFull: () => void;
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void;
}

/** Per-thread unattended loop, sitting next to Full access. Turning it on
 *  forces full access; dirty trees offer a new worktree first. */
export const KeepGoingChip = memo(function KeepGoingChip({
  flag,
  usage,
  cwd,
  onChange,
  onStop,
  onAccessFull,
  onOpenWorktree,
}: KeepGoingChipProps) {
  const on = isKeepGoingOn(flag, usage);
  const turnOn = async (patch?: { maxTurns?: number; maxUsd?: number }) => {
    if (!on) {
      const moved = await maybeOpenWorktree(cwd, onOpenWorktree);
      if (moved) return;
      onAccessFull();
    }
    const base = on && flag
      ? flag
      : startKeepGoing(Date.now(), {
          maxTurns: flag?.maxTurns,
          maxUsd: flag?.maxUsd,
        });
    const next: KeepGoing = { ...base, ...patch };
    if (patch && "maxUsd" in patch && patch.maxUsd == null) delete next.maxUsd;
    onChange(next);
  };
  const turnOff = () => {
    onChange(undefined);
    onStop();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        <Repeat className={`size-4 shrink-0 ${on ? "text-primary" : "opacity-70"}`} />
        <span>Keep going</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem
          onClick={() => (on ? turnOff() : void turnOn())}
          className="justify-between gap-4"
        >
          {on ? "Stop" : "Start"}
          {on && <Check className="size-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Turns</DropdownMenuLabel>
        {TURN_CAPS.map((c) => (
          <DropdownMenuItem
            key={c.label}
            onClick={() => void turnOn({ maxTurns: c.maxTurns })}
            className="justify-between gap-4"
          >
            {c.label}
            {(flag?.maxTurns ?? DEFAULT_MAX_TURNS) === c.maxTurns && (
              <Check className="size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Cost</DropdownMenuLabel>
        {USD_CAPS.map((c) => (
          <DropdownMenuItem
            key={c.label}
            onClick={() => void turnOn({ maxUsd: c.maxUsd })}
            className="justify-between gap-4"
          >
            {c.label}
            {flag?.maxUsd === c.maxUsd && (
              <Check className="size-3.5" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const maybeOpenWorktree = async (
  cwd: string,
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void
): Promise<boolean> => {
  if (!onOpenWorktree) return false;
  let changes: GitFile[] = [];
  try {
    const listed = await invoke<GitFile[]>("git_changes", { path: cwd });
    changes = Array.isArray(listed) ? listed : [];
  } catch {
    return false;
  }
  if (changes.length === 0) return false;
  const go = await ask(
    "This branch has uncommitted changes. Open a new worktree?",
    { title: "Keep going", kind: "warning" }
  );
  if (!go) return false;
  try {
    const repo = await invoke<GitRepoRoot>("git_repo_root", { path: cwd });
    const branch = `emberyx-kg-${Date.now().toString(36)}`;
    const path = await invoke<string>("git_worktree_add", {
      path: repo.mainRoot,
      branch,
      create: true,
      base: null,
    });
    onOpenWorktree(path, repo.mainRoot, branch);
    toast.success("Opened a clean worktree", { description: path });
    return true;
  } catch (e) {
    toast.error("Couldn't open a worktree", { description: String(e) });
    return false;
  }
};
