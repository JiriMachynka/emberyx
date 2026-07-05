import { Play, ChevronDown, Layers, Square } from "lucide-react";
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
  onRunPackage: (pkg: PackageInfo) => void;
  onRunAll: () => void;
  onStop: () => void;
}

export function DevMenu({
  workspace,
  running,
  onRunPackage,
  onRunAll,
  onStop,
}: DevMenuProps) {
  const packages = workspace?.packages ?? [];
  const isMonorepo = packages.length > 1;
  const disabled = packages.length === 0;

  // A dev server is running: offer to stop it instead of starting more.
  if (running) {
    return (
      <Button variant="destructive" size="sm" onClick={onStop}>
        <Square className="size-3 fill-current" />
        Stop
      </Button>
    );
  }

  // Single-package project: click runs it directly, no menu.
  if (!isMonorepo) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => packages[0] && onRunPackage(packages[0])}
        title={packages[0]?.devCommand ?? "No dev script found"}
      >
        <Play className="size-3.5" />
        Dev
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          <Play className="size-3.5" />
          Dev
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel>
          {packages.length} packages · {workspace?.packageManager}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onRunAll()}>
          <Layers className="text-primary" />
          <span className="font-medium">All</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {packages.map((pkg) => (
          <DropdownMenuItem key={pkg.path} onSelect={() => onRunPackage(pkg)}>
            <Play className="opacity-60" />
            <span className="flex-1 truncate">{pkg.name}</span>
            <span className="text-xs text-muted-foreground">{pkg.relPath}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
