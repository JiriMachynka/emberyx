import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { basename, dirname } from "@/lib/path";
import { useGitLog } from "@/lib/queries";
import type { GitLogEntry } from "@/types";

const PAGE = 30;

/** The branch/tag label to show on a commit row, or null when it's just a
 *  detached commit. Strips a leading "HEAD -> " and skips bare HEAD / tags. */
const branchBadge = (refs: string[]): string | null => {
  for (const ref of refs) {
    if (ref === "HEAD" || ref.startsWith("tag:")) continue;
    return ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length) : ref;
  }
  return null;
};

const statusColor = (status: string): string => {
  const code = status[0];
  if (code === "A") return "text-emerald-400";
  if (code === "D") return "text-destructive";
  return "text-amber-400";
};

interface RecentCommitsProps {
  projectPath: string;
  onPickCommitFile: (sha: string, file: string, subject: string) => void;
}

export function RecentCommits({
  projectPath,
  onPickCommitFile,
}: RecentCommitsProps) {
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isFetching } = useGitLog(projectPath, limit);
  const commits = useMemo<GitLogEntry[]>(() => data ?? [], [data]);

  const toggle = useCallback((sha: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  }, []);

  // Grow the page when scrolled near the bottom — but only when the last fetch
  // filled the page (older commits likely exist) and none is in flight.
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (isFetching || commits.length < limit) return;
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight * 0.75) {
        setLimit((n) => n + PAGE);
      }
    },
    [isFetching, commits.length, limit]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-b">
      <div className="group sticky top-0 z-10 flex items-center justify-between bg-card px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          Recent Commits
        </button>
        <span className="tabular-nums">{commits.length}</span>
      </div>

      {open && (
        <div className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
          {commits.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No commits yet.
            </div>
          ) : (
            <ul>
              {commits.map((c) => {
                const isOpen = expanded.has(c.sha);
                const badge = branchBadge(c.refs);
                return (
                  <li key={c.sha} className="relative">
                    {/* Timeline rail: dot at the row, line through the block. */}
                    <span className="pointer-events-none absolute bottom-0 left-4 top-3 border-l border-border" />
                    <button
                      onClick={() => toggle(c.sha)}
                      className="flex w-full items-start gap-2 py-1 pl-2 pr-2 text-left hover:bg-accent"
                    >
                      <span className="relative flex w-4 shrink-0 justify-center pt-1.5">
                        <GitCommit className="size-3 text-muted-foreground" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-xs font-medium">
                            {c.subject}
                          </span>
                          {badge && (
                            <span className="shrink-0 rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                              {badge}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="truncate">{c.author}</span>
                          <span className="shrink-0">{c.relativeDate}</span>
                        </span>
                      </span>
                    </button>

                    {isOpen && (
                      <ul className="pb-1">
                        {c.files.map((f) => {
                          const dir = f.path.includes("/")
                            ? dirname(f.path)
                            : "";
                          return (
                          <li key={f.path} className="relative">
                            <span className="pointer-events-none absolute bottom-0 left-4 top-0 border-l border-border" />
                            <button
                              onClick={() =>
                                onPickCommitFile(c.sha, f.path, c.subject)
                              }
                              className="flex w-full items-center gap-1.5 py-0.5 pl-8 pr-2 text-left hover:bg-accent"
                            >
                              <FileTypeIcon path={f.path} />
                              <span className="min-w-0 flex-1 truncate text-[11px]">
                                {basename(f.path)}
                                {dir && (
                                  <span className="ml-1.5 text-muted-foreground">
                                    {dir}
                                  </span>
                                )}
                              </span>
                              <span
                                className={cn(
                                  "w-4 shrink-0 text-center font-mono text-[10px]",
                                  statusColor(f.status)
                                )}
                              >
                                {f.status[0]}
                              </span>
                            </button>
                          </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
