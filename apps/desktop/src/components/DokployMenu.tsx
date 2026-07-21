import { Server, ChevronDown, Database, Boxes, Package, RotateCw, ScrollText } from "lucide-react";
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
  /** Trigger a redeploy of an application/compose service. */
  onRedeploy: (service: DokployService) => void;
  /** Open a live logs pane for an application service. */
  onViewLogs: (service: DokployService) => void;
}

/** Dropdown of the Dokploy services deploying this project, with per-service
 *  redeploy / logs actions for applications and compose services. */
export function DokployMenu({ match, onOpen, onRedeploy, onViewLogs }: DokployMenuProps) {
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
          const deployable = s.id !== null && (s.kind === "application" || s.kind === "compose");
          const loggable = s.id !== null && s.kind === "application";
          return (
            <DropdownMenuItem
              key={`${s.kind}:${s.name}`}
              // Actions live in the row's buttons; selecting the row is a no-op
              // so it never closes the menu out from under a click.
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
              {deployable ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    title="Redeploy"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRedeploy(s);
                    }}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                  {loggable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 text-muted-foreground hover:text-foreground"
                      title="View logs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onViewLogs(s);
                      }}
                    >
                      <ScrollText className="size-3.5" />
                    </Button>
                  )}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {s.status ?? s.kind}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
