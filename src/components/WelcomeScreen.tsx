import { FolderOpen, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { basename, dirname } from "@/lib/path";

interface WelcomeScreenProps {
  recents: string[];
  onPick: () => void;
  onOpenRecent: (path: string) => void;
}

/** Empty state shown when no project is open: open button + recents. */
export function WelcomeScreen({
  recents,
  onPick,
  onOpenRecent,
}: WelcomeScreenProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
      <img
        src="/emberyx.png"
        alt="Emberyx"
        className="size-16 rounded-2xl shadow-lg"
      />
      <div>
        <h1 className="text-lg font-semibold">Open a project</h1>
        <p className="text-sm text-muted-foreground">
          Emberyx launches your agent in an integrated terminal.
        </p>
      </div>
      <Button onClick={onPick}>
        <FolderOpen className="size-4" />
        Open project…
        <span className="ml-1 text-xs opacity-60">⌘O</span>
      </Button>
      {recents.length > 0 && (
        <div className="w-72 text-left">
          <div className="mb-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <Clock className="size-3" />
            Recent
          </div>
          <ul className="rounded-md border">
            {recents.map((p) => (
              <li key={p}>
                <button
                  onClick={() => onOpenRecent(p)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-sm hover:bg-accent"
                  title={p}
                >
                  <span className="truncate">{basename(p)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {dirname(p)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
