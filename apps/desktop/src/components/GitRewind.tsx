import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitCompare, History, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { highlightCode, langFromPath } from "@/lib/highlight";
import {
  changeAnchors,
  commitType,
  computeLineDiff,
  isBreaking,
  type DiffLine,
} from "@/lib/wordDiff";
import { useGitFileLog, useGitPickaxe, useGitShowFile } from "@/lib/queries";
import type { GitCommit } from "@/types";

/** Stripe color per conventional-commit type; anything else stays neutral. */
const TYPE_COLOR: Record<string, string> = {
  feat: "bg-emerald-500",
  fix: "bg-red-500",
  refactor: "bg-violet-500",
  perf: "bg-amber-500",
  docs: "bg-sky-500",
  test: "bg-teal-500",
  chore: "bg-zinc-500",
  style: "bg-pink-500",
  build: "bg-orange-500",
  ci: "bg-indigo-500",
};

const memoryKey = (file: string) => `emberyx.rewind.${file}`;

interface GitRewindProps {
  projectPath: string;
  /** Repo-relative path of the file to walk. */
  file: string;
  onClose: () => void;
}

/**
 * A file's history as a horizontal timeline (newest right) with the diff each
 * commit introduced. ←/→ (or j/k) step through commits, n/p jump between
 * changes, `/` focuses the filter, and ⌥/⌘-clicking a commit pins it as the
 * base to compare another commit against.
 */
export function GitRewind({ projectPath, file, onClose }: GitRewindProps) {
  const [filter, setFilter] = useState("");
  const [pickaxe, setPickaxe] = useState("");
  const [sha, setSha] = useState<string | null>(
    () => localStorage.getItem(memoryKey(file))
  );
  const [baseSha, setBaseSha] = useState<string | null>(null);
  const [anchor, setAnchor] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);

  const logQuery = useGitFileLog(projectPath, file);
  const commits = useMemo(() => logQuery.data ?? [], [logQuery.data]);
  const pickaxeQuery = useGitPickaxe(projectPath, file, pickaxe);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shas = pickaxe.trim() ? new Set(pickaxeQuery.data ?? []) : null;
    return commits.filter((c) => {
      if (shas && !shas.has(c.sha)) return false;
      if (!q) return true;
      return (
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.sha.startsWith(q)
      );
    });
  }, [commits, filter, pickaxe, pickaxeQuery.data]);

  // Keep the remembered commit while it's visible, else the newest one shown.
  const selected =
    visible.find((c) => c.sha === sha) ?? visible[0] ?? null;
  const index = selected ? commits.findIndex((c) => c.sha === selected.sha) : -1;
  // The same file one commit further back — the "before" side of the diff.
  const previous = index >= 0 ? commits[index + 1] ?? null : null;
  const base = baseSha ? commits.find((c) => c.sha === baseSha) ?? null : null;

  useEffect(() => {
    if (selected) localStorage.setItem(memoryKey(file), selected.sha);
  }, [selected, file]);

  const beforeCommit = base ?? previous;
  const beforeQuery = useGitShowFile(
    projectPath,
    beforeCommit?.sha ?? null,
    // Follow the rename: before the rename commit the file lived at oldPath.
    (base ? base.path : selected?.oldPath ?? previous?.path) ?? null
  );
  const afterQuery = useGitShowFile(
    projectPath,
    selected?.sha ?? null,
    selected?.path ?? null
  );

  const lines = useMemo(
    () =>
      computeLineDiff(
        beforeCommit ? beforeQuery.data ?? "" : "",
        afterQuery.data ?? ""
      ),
    [beforeCommit, beforeQuery.data, afterQuery.data]
  );
  const anchors = useMemo(() => changeAnchors(lines), [lines]);
  const lang = useMemo(() => langFromPath(file), [file]);

  const step = (delta: number) => {
    if (!selected) return;
    const i = visible.findIndex((c) => c.sha === selected.sha);
    const next = visible[i + delta];
    if (next) {
      setSha(next.sha);
      setAnchor(0);
    }
  };

  const jumpChange = (delta: number) => {
    if (!anchors.length) return;
    const next = Math.min(Math.max(anchor + delta, 0), anchors.length - 1);
    setAnchor(next);
    diffRef.current
      ?.querySelector(`[data-line="${anchors[next]}"]`)
      ?.scrollIntoView({ block: "center" });
  };

  function onKeyDown(e: React.KeyboardEvent) {
    // Typing in a field: Esc clears it (and only then closes on a second press).
    if (e.target instanceof HTMLInputElement) {
      if (e.key === "Escape" && e.target.value) {
        e.stopPropagation();
        e.preventDefault();
        setFilter("");
        setPickaxe("");
      }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "j") step(1);
    else if (e.key === "ArrowRight" || e.key === "k") step(-1);
    else if (e.key === "n") jumpChange(1);
    else if (e.key === "p") jumpChange(-1);
    else if (e.key === "/") {
      e.preventDefault();
      filterRef.current?.focus();
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="fixed inset-6 z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <History className="size-4 shrink-0 text-muted-foreground" />
            <Dialog.Title className="shrink-0 text-sm font-medium">
              {basename(file)}
            </Dialog.Title>
            <span className="truncate text-xs text-muted-foreground">{file}</span>

            <div className="ml-auto flex items-center gap-2">
              <Field
                inputRef={filterRef}
                value={filter}
                onChange={setFilter}
                placeholder="Filter author / message / sha  (/)"
                icon={<Search className="size-3.5 text-muted-foreground" />}
              />
              <Field
                value={pickaxe}
                onChange={setPickaxe}
                placeholder="Pickaxe: code added or removed"
                icon={<GitCompare className="size-3.5 text-muted-foreground" />}
              />
              <Dialog.Close className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="size-4" />
              </Dialog.Close>
            </div>
          </header>

          <Timeline
            commits={visible}
            selected={selected}
            base={base}
            onPick={(commit, asBase) => {
              if (asBase) setBaseSha((prev) => (prev === commit.sha ? null : commit.sha));
              else {
                setSha(commit.sha);
                setAnchor(0);
              }
            }}
          />

          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
            {selected ? (
              <>
                {commitType(selected.subject) && (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1 text-[10px] font-medium text-background",
                      TYPE_COLOR[commitType(selected.subject)!] ?? "bg-zinc-500"
                    )}
                  >
                    {commitType(selected.subject)}
                    {isBreaking(selected.subject) && "!"}
                  </span>
                )}
                <span className="truncate font-medium">{selected.subject}</span>
                <span className="shrink-0 text-muted-foreground">
                  {selected.author} · {selected.relativeDate} · {selected.shortSha}
                </span>
                {selected.oldPath && (
                  <span className="shrink-0 rounded bg-violet-500/20 px-1 text-[10px] text-violet-300">
                    renamed from {selected.oldPath}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {base
                    ? `compared to ${base.shortSha}`
                    : previous
                      ? `vs ${previous.shortSha}`
                      : "initial commit"}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">
                {logQuery.isPending ? "Reading history…" : "No commits match."}
              </span>
            )}
          </div>

          <div ref={diffRef} className="min-h-0 flex-1 overflow-auto">
            {selected ? (
              <DiffView lines={lines} lang={lang} />
            ) : (
              <p className="p-4 text-center text-xs text-muted-foreground">
                {logQuery.isError
                  ? String(logQuery.error)
                  : "This file has no tracked history."}
              </p>
            )}
          </div>

          <footer className="flex h-8 shrink-0 items-center gap-3 border-t px-3 text-[11px] text-muted-foreground">
            <span>←/j older · →/k newer</span>
            <span>n/p next/prev change</span>
            <span>⌥-click a commit to pin a compare base</span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Horizontal commit strip, oldest left / newest right. */
function Timeline({
  commits,
  selected,
  base,
  onPick,
}: {
  commits: GitCommit[];
  selected: GitCommit | null;
  base: GitCommit | null;
  onPick: (commit: GitCommit, asBase: boolean) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);

  // Keep the selected commit in view as the arrow keys walk the history.
  useEffect(() => {
    strip.current
      ?.querySelector(`[data-sha="${selected?.sha}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [selected?.sha]);

  return (
    <div ref={strip} className="flex shrink-0 gap-1 overflow-x-auto border-b p-2">
      {[...commits].reverse().map((c) => {
        const type = commitType(c.subject);
        return (
          <button
            key={c.sha}
            data-sha={c.sha}
            onClick={(e) => onPick(c, e.altKey || e.metaKey)}
            title={`${c.subject}\n${c.author} · ${c.relativeDate}`}
            className={cn(
              "flex w-28 shrink-0 flex-col gap-1 rounded border px-2 py-1 text-left",
              c.sha === selected?.sha
                ? "border-primary bg-secondary"
                : c.sha === base?.sha
                  ? "border-amber-500/60 bg-amber-500/10"
                  : "border-transparent hover:bg-accent"
            )}
          >
            <span
              className={cn(
                "h-0.5 w-full rounded",
                type ? TYPE_COLOR[type] ?? "bg-zinc-500" : "bg-zinc-700"
              )}
            />
            <span className="truncate text-[11px]">{c.subject}</span>
            <span className="flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
              {c.shortSha}
              {c.oldPath && (
                <span className="rounded bg-violet-500/30 px-0.5 text-violet-200">
                  R
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The commit's diff, syntax-highlighted, with word-level tinting. */
function DiffView({ lines, lang }: { lines: DiffLine[]; lang: string | null }) {
  if (!lines.length) {
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        No textual changes in this commit.
      </p>
    );
  }
  return (
    <pre className="w-max min-w-full whitespace-pre py-1 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          data-line={i}
          className={cn(
            "border-l-2 pr-3",
            line.type === "add"
              ? "border-emerald-500/50 bg-emerald-500/10"
              : line.type === "del"
                ? "border-red-500/50 bg-red-500/10"
                : "border-transparent"
          )}
        >
          <span className="inline-block w-10 select-none pr-2 text-right text-muted-foreground/50 tabular-nums">
            {line.oldNum ?? ""}
          </span>
          <span className="inline-block w-10 select-none pr-2 text-right text-muted-foreground/50 tabular-nums">
            {line.newNum ?? ""}
          </span>
          <span className="inline-block w-4 select-none text-center opacity-40">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          {line.wordOps ? (
            <span>
              {line.wordOps.map((op, j) => (
                <span
                  key={j}
                  className={cn(
                    op.type === "add" && "bg-emerald-500/35",
                    op.type === "del" && "bg-red-500/35"
                  )}
                  dangerouslySetInnerHTML={{
                    __html: highlightCode(op.text, lang),
                  }}
                />
              ))}
            </span>
          ) : (
            <span
              dangerouslySetInnerHTML={{
                __html: highlightCode(line.content, lang) || " ",
              }}
            />
          )}
        </div>
      ))}
    </pre>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  icon,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  icon: React.ReactNode;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex w-56 items-center gap-1.5 rounded border bg-background px-2">
      {icon}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
