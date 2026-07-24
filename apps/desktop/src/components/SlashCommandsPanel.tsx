import { useMemo, useState } from "react";
import { SlashSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SidePanel } from "@/components/SidePanel";
import { useSlashCommands } from "@/lib/queries";
import { filterCommands } from "@/lib/slash";
import { mergeCommands } from "@/lib/builtinCommands";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";

interface SlashCommandsPanelProps {
  onClose: () => void;
  /** Active project root; null before a project is open. */
  cwd: string | null;
  /** Active chat session, or null when the active tab isn't a chat. */
  activeChatId: string | null;
}

/** Browsable list of every slash command — built-in, project, user, plugin.
 *  Clicking one runs it immediately in the active chat session. */
export function SlashCommandsPanel({ onClose, cwd, activeChatId }: SlashCommandsPanelProps) {
  const [query, setQuery] = useState("");
  const { data, isLoading } = useSlashCommands(cwd ?? "", !!cwd);
  const send = useAgentStore((s) => (activeChatId ? s.senders[activeChatId] : undefined));

  const commands = useMemo(
    () => filterCommands(mergeCommands(data ?? []), query, 200),
    [data, query]
  );

  const run = (name: string) => {
    if (!send) return;
    send(`/${name}`);
    onClose();
  };

  return (
    <SidePanel
      storageKey="slash"
      onClose={onClose}
      header={
        <div className="flex items-center gap-2 text-sm font-medium">
          <SlashSquare className="size-4" />
          Commands
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands…"
            className="h-8 text-xs"
          />
          {!send && (
            <p className="mt-2 text-[0.7rem] text-muted-foreground">
              Open a chat session to run a command.
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">Loading commands…</p>
          ) : commands.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">No matching command.</p>
          ) : (
            commands.map((command) => (
              <button
                key={`${command.source}:${command.name}`}
                type="button"
                disabled={!send}
                onClick={() => run(command.name)}
                title={send ? `Run /${command.name}` : "Open a chat session first"}
                className={cn(
                  "flex w-full items-baseline gap-2 border-b border-border/50 px-3 py-1.5 text-left text-xs",
                  send ? "hover:bg-accent" : "cursor-not-allowed opacity-60"
                )}
              >
                <span className="shrink-0 font-medium">/{command.name}</span>
                {command.description && (
                  <span className="truncate text-muted-foreground">{command.description}</span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                  {command.source}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </SidePanel>
  );
}
