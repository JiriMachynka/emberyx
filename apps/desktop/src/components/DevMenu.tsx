import {
  Play,
  ChevronDown,
  Layers,
  Square,
  Pencil,
  Hammer,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /** Effective build command (override or detected); empty = nothing to run. */
  buildCommand: string;
  /** Effective start command for the built app; empty = nothing to run. */
  startCommand: string;
  /** Python project with no JS packages — the custom command is the only way in. */
  isPython: boolean;
  /** Opens the project settings pane, which owns editing the dev command. */
  onEditCustom: () => void;
  onRunCustom: () => void;
  onRunBuild: () => void;
  onRunStart: () => void;
  onRunPackage: (pkg: PackageInfo) => void;
  onRunAll: () => void;
  onStop: () => void;
}

export function DevMenu({
  workspace,
  running,
  customCommand,
  buildCommand,
  startCommand,
  isPython,
  onEditCustom,
  onRunCustom,
  onRunBuild,
  onRunStart,
  onRunPackage,
  onRunAll,
  onStop,
}: DevMenuProps) {
  const packages = workspace?.packages ?? [];
  const isMonorepo = packages.length > 1;
  const hasCustom = customCommand.trim().length > 0;
  const hasBuild = buildCommand.trim().length > 0;
  const hasStart = startCommand.trim().length > 0;

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
        : isPython
          ? "Set a custom dev command for this Python project"
          : "No dev script found — set a custom command";

  return (
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
          <DropdownMenuItem onSelect={onEditCustom}>
            <Pencil className="opacity-60" />
            <span className="flex-1">Custom command…</span>
            {hasCustom && (
              <span className="max-w-[7rem] truncate text-xs text-muted-foreground">
                {customCommand}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!hasBuild}
            onSelect={() => onRunBuild()}
            title={hasBuild ? buildCommand : undefined}
          >
            <Hammer className="opacity-60" />
            <span className="flex-1">Build</span>
            {hasBuild && (
              <span className="max-w-[7rem] truncate text-xs text-muted-foreground">
                {buildCommand}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasStart}
            onSelect={() => onRunStart()}
            title={hasStart ? startCommand : undefined}
          >
            <Rocket className="opacity-60" />
            <span className="flex-1">Start built app</span>
            {hasStart && (
              <span className="max-w-[7rem] truncate text-xs text-muted-foreground">
                {startCommand}
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
  );
}
