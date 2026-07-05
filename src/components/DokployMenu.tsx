import { Server, ChevronDown, Database, Boxes, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { DokployMatch, DokployService } from "@/types";

const DB_KINDS = ["postgres", "mysql", "mariadb", "mongo", "redis"];

function kindIcon(kind: string) {
  if (kind === "compose") return Boxes;
  if (DB_KINDS.includes(kind)) return Database;
  return Package;
}

/** Colour for a Dokploy deploy status dot. */
function statusDot(status: string | null): string {
  switch (status) {
    case "running":
    case "done":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-muted-foreground/40";
  }
}

interface DokployMenuProps {
  match: DokployMatch;
  /** Kick a background refresh when the menu opens. */
  onOpen: () => void;
}

/** Read-only dropdown of the Dokploy services deploying this project. */
export function DokployMenu({ match, onOpen }: DokployMenuProps) {
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title={`Deployed on Dokploy · ${match.projectName}`}>
          <Server className="size-3.5" />
          Dokploy
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-auto">
        <DropdownMenuLabel className="truncate">{match.projectName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {match.services.map((s: DokployService) => {
          const Icon = kindIcon(s.kind);
          const isMatched = s.name === match.matchedService;
          return (
            <DropdownMenuItem
              key={`${s.kind}:${s.name}`}
              // View-only; selecting does nothing but keep the row focusable.
              onSelect={(e) => e.preventDefault()}
              className="gap-2"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(s.status))} />
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span
                className={cn("flex-1 truncate text-sm", isMatched && "font-medium")}
                title={isMatched ? "This repo" : undefined}
              >
                {s.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {s.status ?? s.kind}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
