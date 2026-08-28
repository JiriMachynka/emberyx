import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { useDirEntries } from "@/lib/queries";
import type { DirEntry } from "@/types";

function Row({
  depth,
  active,
  onClick,
  children,
}: {
  depth: number;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cn(
        "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs hover:bg-accent",
        active && "bg-accent text-foreground"
      )}
    >
      {children}
    </button>
  );
}

interface TreeProps {
  path: string;
  name: string;
  depth: number;
  selected: string | null;
  dirtyPaths: Set<string>;
  onSelect: (path: string) => void;
  /** Root starts expanded; nested dirs open on click. */
  defaultOpen?: boolean;
}

/** One directory row plus its lazily-listed children. */
function TreeDir({
  path,
  name,
  depth,
  selected,
  dirtyPaths,
  onSelect,
  defaultOpen = false,
}: TreeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const entries = useDirEntries(path, open).data ?? [];

  // A file opened from somewhere else — a chat reference, the finder — has to
  // be visible in the tree, not just loaded in the editor. Each ancestor opens
  // itself, and its children mount and do the same, so the chain unfolds.
  const holdsSelection = selected !== null && selected.startsWith(`${path}/`);
  useEffect(() => {
    if (holdsSelection) setOpen(true);
  }, [holdsSelection]);

  return (
    <>
      <Row depth={depth} onClick={() => setOpen((o) => !o)}>
        {open ? (
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        ) : (
          <ChevronRight className="size-3 shrink-0 opacity-60" />
        )}
        {open ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{name}</span>
      </Row>
      {open &&
        entries.map((e: DirEntry) =>
          e.isDir ? (
            <TreeDir
              key={e.path}
              path={e.path}
              name={e.name}
              depth={depth + 1}
              selected={selected}
              dirtyPaths={dirtyPaths}
              onSelect={onSelect}
            />
          ) : (
            <Row
              key={e.path}
              depth={depth + 1}
              active={e.path === selected}
              onClick={() => onSelect(e.path)}
            >
              <FileTypeIcon path={e.name} />
              <span className="truncate">{e.name}</span>
              {dirtyPaths.has(e.path) && (
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
              )}
            </Row>
          )
        )}
    </>
  );
}

/** The project's directory tree, expanded lazily one level at a time. */
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
  return (
    <TreeDir
      path={root}
      name={name}
      depth={0}
      selected={selected}
      dirtyPaths={dirtyPaths}
      onSelect={onSelect}
      defaultOpen
    />
  );
}
