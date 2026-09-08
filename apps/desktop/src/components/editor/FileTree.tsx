/**
 * The project's directory tree, expanded lazily one level at a time.
 *
 * Flat and virtualized rather than a recursive component tree: expanding a
 * generated directory used to mount a row per entry, and `node_modules` alone
 * is tens of thousands of them. The open set and every listing live here, the
 * flattening is `lib/dirRows.ts`, and only the visible rows are rendered.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { buildDirRows, openToward } from "@/lib/dirRows";
import { dirEntriesQuery } from "@/lib/queries";
import type { DirEntry } from "@/types";

/** Row height in px. Fixed, so the virtualizer needs no measuring pass. */
const ROW_HEIGHT = 24;

export function FileTree({
  root,
  name,
  selected,
  dirtyPaths,
  onSelect,
}: {
  root: string;
  name: string;
  selected: string | null;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([root]));

  // A file opened from somewhere else - a chat reference, the finder - has to
  // be visible in the tree, not just loaded in the editor.
  useEffect(() => {
    if (!selected) return;
    setOpen((prev) => openToward(prev, root, selected));
  }, [selected, root]);

  const dirs = useMemo(() => [...open], [open]);
  const listings = useQueries({ queries: dirs.map((dir) => dirEntriesQuery(dir)) });
  // `listings` is a new array on every render, so the fingerprint is what the
  // map is rebuilt on: the listings themselves, not the wrapper.
  const fingerprint = listings.map((l) => l.dataUpdatedAt).join(",");
  const entries = useMemo(() => {
    const map = new Map<string, DirEntry[]>();
    dirs.forEach((dir, i) => {
      const data = listings[i]?.data;
      if (data) map.set(dir, data);
    });
    return map;
  }, [dirs, fingerprint]);

  const rows = useMemo(
    () => buildDirRows(root, name, open, entries),
    [root, name, open, entries]
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div ref={scrollRef} className="h-full overflow-auto py-1">
      <div className="relative w-full" style={{ height: virt.getTotalSize() }}>
        {virt.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <button
              key={row.path}
              onClick={() => (row.isDir ? toggle(row.path) : onSelect(row.path))}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transform: `translateY(${item.start}px)`,
                height: ROW_HEIGHT,
                paddingLeft: 6 + row.depth * 12,
              }}
              className={cn(
                "flex w-full items-center gap-1.5 pr-2 text-left text-xs hover:bg-accent",
                !row.isDir && row.path === selected && "bg-accent text-foreground"
              )}
            >
              {row.isDir ? (
                <>
                  {row.open ? (
                    <ChevronDown className="size-3 shrink-0 opacity-60" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 opacity-60" />
                  )}
                  {row.open ? (
                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                </>
              ) : (
                <FileTypeIcon path={row.name} />
              )}
              <span className="truncate">{row.name}</span>
              {!row.isDir && dirtyPaths.has(row.path) && (
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
