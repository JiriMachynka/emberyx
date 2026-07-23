import { cn } from "@/lib/utils";
import type { SlashCommand } from "@/types";

interface SlashMenuProps {
  commands: SlashCommand[];
  loading: boolean;
  query: string;
  active: number;
  onHover: (index: number) => void;
  onPick: (name: string) => void;
}

/** Command palette for `/` at the start of the composer — the chat equivalent
 *  of the CLI's slash-command list. The composer owns the keyboard. */
export function SlashMenu({
  commands,
  loading,
  query,
  active,
  onHover,
  onPick,
}: SlashMenuProps) {
  if (loading || commands.length === 0) {
    return (
      <div className="mb-2 rounded-xl border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
        {loading ? "Loading commands…" : `No command matches “${query}”.`}
      </div>
    );
  }

  return (
    <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg">
      {commands.map((command, i) => (
        <button
          key={`${command.source}:${command.name}`}
          type="button"
          ref={
            i === active
              ? (el) => el?.scrollIntoView({ block: "nearest" })
              : undefined
          }
          onMouseMove={() => onHover(i)}
          // Keep focus in the composer so its blur handler doesn't close the
          // menu before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(command.name)}
          className={cn(
            "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs",
            i === active && "bg-accent"
          )}
        >
          <span className="shrink-0 font-medium">/{command.name}</span>
          {command.description && (
            <span className="truncate text-muted-foreground">
              {command.description}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
            {command.source}
          </span>
        </button>
      ))}
      <p className="sticky bottom-0 border-t border-border bg-popover px-3 py-1 text-[10px] text-muted-foreground">
        ↑↓ to choose · Enter or Tab to insert · Esc to dismiss
      </p>
    </div>
  );
}
