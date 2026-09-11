import { memo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGitBranch, useGitBranches, useInvalidateGit } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { chipTrigger, chipTriggerSm } from "@/components/composer/chipStyles";

/** Current branch, click to checkout another local one. Hidden when the cwd
 *  isn't a git repo. */
export const BranchChip = memo(function BranchChip({
  cwd,
  busy,
  compact,
}: {
  cwd: string;
  busy: boolean;
  /** Rendered in the session strip under the input rather than in the
   *  composer's own control row, where the type is a step larger. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const branch = useGitBranch(cwd).data?.branch;
  const branches = useGitBranches(cwd, open).data ?? [];
  const invalidateGit = useInvalidateGit();

  if (!branch) return null;

  const checkout = async (name: string) => {
    if (name === branch) return;
    if (busy) {
      const ok = await ask(
        `A turn is in progress. Switch to branch "${name}" anyway?`,
        { title: "Switch branch", kind: "warning" },
      );
      if (!ok) return;
    }
    try {
      await invoke<string>("git_checkout", {
        path: cwd,
        branch: name,
        create: false,
      });
      invalidateGit(cwd);
    } catch (e) {
      toast.error("Checkout failed", { description: String(e) });
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={compact ? chipTriggerSm : chipTrigger}
        title={`On branch ${branch}`}
      >
        <GitBranch
          className={cn("shrink-0 opacity-70", compact ? "size-3.5" : "size-4")}
        />
        <span className="whitespace-nowrap">{branch}</span>
        <ChevronDown
          className={cn("shrink-0 opacity-50", compact ? "size-3" : "size-3.5")}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>Checkout</DropdownMenuLabel>
        {branches.map((name) => (
          <DropdownMenuItem
            key={name}
            disabled={name === branch}
            onSelect={() => void checkout(name)}
            className="justify-between gap-4"
          >
            <span className="truncate">{name}</span>
            {name === branch && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
