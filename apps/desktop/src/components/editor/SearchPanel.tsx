import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, Regex, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename, dirname } from "@/lib/path";
import { fileIcon } from "@/lib/fileIcon";
import { useSearchText } from "@/lib/queries";
import type { SearchFile } from "@/types";

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
  const files = results.data ?? [];
  const total = files.reduce((n, f) => n + f.hits.length, 0);

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
          ) : query && files.length ? (
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

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {files.map((file) => (
          <FileGroup
            key={file.path}
            file={file}
            collapsed={collapsed.has(file.path)}
            onToggle={() => toggleFile(file.path)}
            onOpenHit={onOpenHit}
          />
        ))}
      </div>
    </div>
  );
}

function FileGroup({
  file,
  collapsed,
  onToggle,
  onOpenHit,
}: {
  file: SearchFile;
  collapsed: boolean;
  onToggle: () => void;
  onOpenHit: (relPath: string, line: number) => void;
}) {
  const { Icon, className } = fileIcon(basename(file.path));
  const dir = dirname(file.path);
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-accent"
        title={file.path}
      >
        {collapsed ? (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        )}
        <Icon className={cn("size-3.5 shrink-0", className)} />
        <span className="truncate">{basename(file.path)}</span>
        {dir !== file.path && (
          <span className="truncate text-muted-foreground">{dir}</span>
        )}
        <span className="ml-auto shrink-0 rounded bg-secondary px-1 text-[10px] tabular-nums text-muted-foreground">
          {file.hits.length}
        </span>
      </button>
      {!collapsed &&
        file.hits.map((hit) => (
          <button
            key={hit.line}
            onClick={() => onOpenHit(file.path, hit.line)}
            className="flex w-full items-baseline gap-2 py-0.5 pl-7 pr-2 text-left font-mono text-[11px] hover:bg-accent"
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
        ))}
    </div>
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
