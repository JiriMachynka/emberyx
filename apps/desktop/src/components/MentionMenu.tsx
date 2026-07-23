import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { fileIcon } from "@/lib/fileIcon";
import type { FuzzyHit } from "@/lib/fuzzy";

/** The path with the query's matched characters picked out. */
function Highlighted({ hit, from, to }: { hit: FuzzyHit; from: number; to?: number }) {
  const marked = new Set(hit.positions.map((p) => p - from));
  return (
    <>
      {[...hit.value.slice(from, to)].map((ch, i) => (
        <span key={i} className={marked.has(i) ? "text-primary" : undefined}>
          {ch}
        </span>
      ))}
    </>
  );
}

interface MentionMenuProps {
  hits: FuzzyHit[];
  /** Null while the file list is still being walked. */
  indexing: boolean;
  query: string;
  active: number;
  onHover: (index: number) => void;
  onPick: (relPath: string) => void;
}

/** File picker that hangs above the composer while an `@` reference is being
 *  typed. Presentational — the composer owns the query and the keyboard. */
export function MentionMenu({
  hits,
  indexing,
  query,
  active,
  onHover,
  onPick,
}: MentionMenuProps) {
  if (indexing || hits.length === 0) {
    return (
      <div className="mb-2 rounded-xl border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
        {indexing ? "Indexing files…" : `No files match “${query}”.`}
      </div>
    );
  }

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
      {hits.map((hit, i) => {
        const { Icon, className } = fileIcon(basename(hit.value));
        const dir = dirname(hit.value);
        const nameAt = hit.value.length - basename(hit.value).length;
        return (
          <button
            key={hit.value}
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
            onClick={() => onPick(hit.value)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
              i === active && "bg-accent"
            )}
          >
            <Icon className={cn("size-3.5 shrink-0", className)} />
            <span className="shrink-0 truncate">
              <Highlighted hit={hit} from={nameAt} />
            </span>
            {dir !== hit.value && (
              <span className="truncate text-muted-foreground">
                <Highlighted hit={hit} from={0} to={nameAt - 1} />
              </span>
            )}
          </button>
        );
      })}
      <p className="border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        ↑↓ to choose · Enter or Tab to insert · Esc to dismiss
      </p>
    </div>
  );
}
