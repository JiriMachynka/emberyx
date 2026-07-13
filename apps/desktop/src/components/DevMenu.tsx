import { useState } from "react";
import { Play, ChevronDown, Layers, Square, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { PackageInfo, WorkspaceInfo } from "@/types";

interface DevMenuProps {
  workspace: WorkspaceInfo | null;
  running: boolean;
  /** Per-project custom dev command; overrides detection when set. */
  customCommand: string;
  onSetCustom: (command: string) => void;
  onRunCustom: () => void;
  onRunPackage: (pkg: PackageInfo) => void;
  onRunAll: () => void;
  onStop: () => void;
}

export function DevMenu({
  workspace,
  running,
  customCommand,
  onSetCustom,
  onRunCustom,
  onRunPackage,
  onRunAll,
  onStop,
}: DevMenuProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const packages = workspace?.packages ?? [];
  const isMonorepo = packages.length > 1;
  const hasCustom = customCommand.trim().length > 0;

  if (running) {
    return (
      <Button variant="destructive" size="sm" onClick={onStop}>
        <Square className="size-3 fill-current" />
        Stop
      </Button>
    );
  }

  // What the primary "Dev" button runs: custom command first, then a lone
  // package, then "All" for a monorepo. Null = nothing to run yet.
  const primaryRun = hasCustom
    ? onRunCustom
    : packages.length === 1
      ? () => onRunPackage(packages[0])
      : isMonorepo
        ? onRunAll
        : null;
  const primaryTitle = hasCustom
    ? customCommand
    : packages.length === 1
      ? packages[0].devCommand
      : isMonorepo
        ? workspace?.allCommand ?? "Run all packages"
        : "No dev script found — set a custom command";

  function openEditor() {
    setDraft(customCommand);
    setEditOpen(true);
  }

  function saveEditor() {
    onSetCustom(draft);
    setEditOpen(false);
  }

  return (
    <>
      <div className="flex items-center">
        <Button
          variant="secondary"
          size="sm"
          className="rounded-r-none"
          disabled={!primaryRun}
          onClick={() => primaryRun?.()}
          title={primaryTitle}
        >
          <Play className="size-3.5" />
          Dev
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-l-none border-l border-border/60 px-1.5"
              aria-label="Dev options"
            >
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[15rem]">
            <DropdownMenuItem onSelect={openEditor}>
              <Pencil className="opacity-60" />
              <span className="flex-1">Custom command…</span>
              {hasCustom && (
                <span className="max-w-[7rem] truncate text-xs text-muted-foreground">
                  {customCommand}
                </span>
              )}
            </DropdownMenuItem>
            {packages.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>
                  {packages.length} package{packages.length > 1 ? "s" : ""} ·{" "}
                  {workspace?.packageManager}
                </DropdownMenuLabel>
                {isMonorepo && (
                  <DropdownMenuItem onSelect={() => onRunAll()}>
                    <Layers className="text-primary" />
                    <span className="font-medium">All</span>
                  </DropdownMenuItem>
                )}
                {packages.map((pkg) => (
                  <DropdownMenuItem
                    key={pkg.path}
                    onSelect={() => onRunPackage(pkg)}
                  >
                    <Play className="opacity-60" />
                    <span className="flex-1 truncate">{pkg.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {pkg.relPath}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom dev command</DialogTitle>
            <DialogDescription>
              Runs at the project root instead of the detected packages. Leave
              blank to fall back to workspace detection.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEditor();
            }}
            placeholder="e.g. turbo run dev --filter=web"
            spellCheck={false}
          />
          <div className="flex justify-end gap-2">
            {hasCustom && (
              <Button
                variant="ghost"
                onClick={() => {
                  onSetCustom("");
                  setEditOpen(false);
                }}
              >
                Clear
              </Button>
            )}
            <Button onClick={saveEditor}>Save</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
