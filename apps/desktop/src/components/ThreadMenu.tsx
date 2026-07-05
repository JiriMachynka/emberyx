import { History, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { Thread } from "@/types";

function relTime(secs: number): string {
  const diff = Date.now() / 1000 - secs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface ThreadMenuProps {
  /** Cached threads (fetched on project open); rendered instantly. */
  threads: Thread[];
  /** Kick a background refresh when the menu opens. */
  onOpen: () => void;
  onResume: (thread: Thread) => void;
}

/** Dropdown of Claude Code threads for the project; selecting one resumes it. */
export function ThreadMenu({ threads, onOpen, onResume }: ThreadMenuProps) {
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" title="Resume a Claude Code thread">
          <History className="size-3.5" />
          Threads
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-96 w-80 overflow-auto"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel>
          {threads.length
            ? `${threads.length} thread${threads.length > 1 ? "s" : ""}`
            : "No threads yet"}
        </DropdownMenuLabel>
        {threads.length > 0 && <DropdownMenuSeparator />}
        {threads.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => onResume(t)}
            className="flex-col items-start gap-0.5"
          >
            <span className="w-full truncate text-sm">{t.title}</span>
            <span className="text-xs text-muted-foreground">
              {relTime(t.modified)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
