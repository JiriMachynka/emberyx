import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { fileIcon } from "@/lib/fileIcon";
import { fuzzyFilter, type FuzzyHit } from "@/lib/fuzzy";
import { useProjectFiles } from "@/lib/queries";

/** A slice of the path with the query's matched characters picked out. */
function Highlighted({
  hit,
  start,
  end,
}: {
  hit: FuzzyHit;
  start: number;
  end?: number;
}) {
  const marked = new Set(hit.positions.map((p) => p - start));
  return (
    <>
      {[...hit.value.slice(start, end)].map((ch, i) => (
        <span key={i} className={marked.has(i) ? "text-primary" : undefined}>
          {ch}
        </span>
      ))}
    </>
  );
}

const LIMIT = 100;

interface FileFinderProps {
  projectPath: string;
  onPick: (relPath: string) => void;
  onClose: () => void;
}

/** ⌘K file browser scoped to the editor: fuzzy-match every file in the project
 *  and open the chosen one. Arrows move, Enter opens, Esc closes. */
export function FileFinder({ projectPath, onPick, onClose }: FileFinderProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const filesQuery = useProjectFiles(projectPath, true);
  const files = filesQuery.data ?? [];

  const hits = useMemo(() => fuzzyFilter(files, query, LIMIT), [files, query]);
  const active = hits[Math.min(cursor, hits.length - 1)];

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) onPick(active.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex justify-center bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-12 h-fit max-h-[70%] w-[32rem] max-w-[90%] overflow-hidden rounded-md border bg-popover shadow-xl"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              filesQuery.isPending ? "Indexing files…" : `Search ${files.length} files`
            }
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="max-h-96 overflow-auto py-1">
          {hits.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {filesQuery.isPending ? "Indexing…" : "No matching files"}
            </div>
          ) : (
            hits.map((hit, i) => {
              const { Icon, className } = fileIcon(basename(hit.value));
              const dir = dirname(hit.value);
              const nameAt = hit.value.length - basename(hit.value).length;
              return (
                <button
                  key={hit.value}
                  ref={
                    hit === active
                      ? (el) => el?.scrollIntoView({ block: "nearest" })
                      : undefined
                  }
                  onMouseMove={() => setCursor(i)}
                  onClick={() => onPick(hit.value)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                    hit === active && "bg-accent"
                  )}
                >
                  <Icon className={cn("size-3.5 shrink-0", className)} />
                  <span className="shrink-0 truncate">
                    <Highlighted hit={hit} start={nameAt} />
                  </span>
                  {dir !== hit.value && (
                    <span className="truncate text-muted-foreground">
                      <Highlighted hit={hit} start={0} end={nameAt - 1} />
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
