import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { useSearchText } from "@/lib/queries";
import {
  SEARCH_ROW_HEIGHT,
  buildSearchRows,
  countHits,
} from "@/lib/searchRows";
import type { SearchHit } from "@/types";

interface SearchPanelProps {
  projectPath: string;
  /** Bumped by the ⇧⌘F shortcut to refocus the input on an already-open panel. */
  focusToken: number;
  onOpenHit: (relPath: string, line: number) => void;
}

/**
 * Project-wide content search for the editor's left column. The query only runs
 * on Enter — the backend walks every file, so live search per keystroke would
 * be wasteful. Results group by file; clicking a line opens it there.
 */
export function SearchPanel({
  projectPath,
  focusToken,
  onOpenHit,
}: SearchPanelProps) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useSearchText(projectPath, query, caseSensitive, isRegex);
  const files = results.data;
  const total = useMemo(() => countHits(files ?? []), [files]);
  // Header and hit rows in one list, so the panel virtualizes them together —
  // a query matching a few thousand lines mounts a screenful, not all of them.
  const rows = useMemo(
    () => buildSearchRows(files ?? [], collapsed),
    [files, collapsed]
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => SEARCH_ROW_HEIGHT[rows[i].kind],
    overscan: 16,
  });

  useEffect(() => {
    inputRef.current?.select();
  }, [focusToken]);

  const toggleFile = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b p-2">
        <div className="flex items-center gap-1 rounded border bg-background px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setQuery(draft.trim());
            }}
            placeholder="Search project…"
            className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <Toggle
            active={caseSensitive}
            title="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            <CaseSensitive className="size-3.5" />
          </Toggle>
          <Toggle
            active={isRegex}
            title="Regular expression"
            onClick={() => setIsRegex((v) => !v)}
          >
            <Regex className="size-3.5" />
          </Toggle>
        </div>
        <p className="px-0.5 text-[11px] text-muted-foreground">
          {results.isError ? (
            <span className="text-destructive">{String(results.error)}</span>
          ) : results.isFetching ? (
            "Searching…"
          ) : query && files?.length ? (
            `${total} result${total === 1 ? "" : "s"} in ${files.length} file${
              files.length === 1 ? "" : "s"
            }`
          ) : query ? (
            "No results"
          ) : (
            "Enter to search"
          )}
        </p>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1">
        <div className="relative w-full" style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                key={row.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                  height: SEARCH_ROW_HEIGHT[row.kind],
                }}
              >
                {row.kind === "file" ? (
                  <FileHeader
                    path={row.file.path}
                    count={row.file.hits.length}
                    collapsed={row.collapsed}
                    onToggle={() => toggleFile(row.file.path)}
                  />
                ) : (
                  <HitRow
                    hit={row.hit}
                    onClick={() => onOpenHit(row.path, row.hit.line)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FileHeader({
  path,
  count,
  collapsed,
  onToggle,
}: {
  path: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const dir = dirname(path);
  return (
    <button
      onClick={onToggle}
      className="flex h-full w-full items-center gap-1 px-2 text-left text-xs hover:bg-accent"
      title={path}
    >
      {collapsed ? (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      )}
      <FileTypeIcon path={path} />
      <span className="truncate">{basename(path)}</span>
      {dir !== path && <span className="truncate text-muted-foreground">{dir}</span>}
      <span className="ml-auto shrink-0 rounded bg-secondary px-1 text-[10px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}

function HitRow({ hit, onClick }: { hit: SearchHit; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-full w-full items-center gap-2 pl-7 pr-2 text-left font-mono text-[11px] hover:bg-accent"
    >
      <span className="w-8 shrink-0 text-right text-muted-foreground/60 tabular-nums">
        {hit.line}
      </span>
      <span className="truncate">
        {hit.text.slice(0, hit.start)}
        <mark className="bg-primary/30 text-foreground">
          {hit.text.slice(hit.start, hit.end)}
        </mark>
        {hit.text.slice(hit.end)}
      </span>
    </button>
  );
}

function Toggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "shrink-0 rounded p-1",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
