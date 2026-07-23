import type { DefMatch } from "@/types";

/** Shown when a symbol has several definitions: pick which one to open. */
export function DefinitionPicker({
  symbol,
  matches,
  projectPath,
  onPick,
  onClose,
}: {
  symbol: string;
  matches: DefMatch[];
  projectPath: string;
  onPick: (match: DefMatch) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute left-2 right-2 top-9 z-20 max-h-64 overflow-auto rounded-md border bg-popover shadow-lg">
      <div className="flex items-center justify-between border-b px-2 py-1.5 text-xs text-muted-foreground">
        <span>
          {matches.length} definitions of{" "}
          <span className="text-foreground">{symbol}</span>
        </span>
        <button
          onClick={onClose}
          className="rounded px-1 hover:bg-accent hover:text-foreground"
        >
          Esc
        </button>
      </div>
      {matches.map((m) => (
        <button
          key={`${m.path}:${m.line}`}
          onClick={() => onPick(m)}
          className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-accent"
        >
          <span className="truncate text-xs text-muted-foreground">
            {m.path.replace(projectPath + "/", "")}:{m.line}
          </span>
          <span className="truncate font-mono text-xs">{m.text}</span>
        </button>
      ))}
    </div>
  );
}
