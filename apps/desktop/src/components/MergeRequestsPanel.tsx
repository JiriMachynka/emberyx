import { memo, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseDiff } from "@/lib/hunks";
import { highlightCode, langFromPath } from "@/lib/highlight";
import {
  invalidateForge,
  useForgeMr,
  useForgeMrDiff,
  useForgeMrNotes,
  useForgeCliStatus,
  useForgeMrs,
  useGitBranch,
  useInvalidateGit,
} from "@/lib/queries";
import {
  FORGE_LABEL,
  FORGE_NOUN,
  isMissingRemote,
  type RemoteHost,
} from "@/lib/forge";
import type { MergeOutcome, MergeRequest, MrState } from "@/lib/gitlab";
import { SidePanel } from "@/components/SidePanel";

const STATES: MrState[] = ["opened", "merged", "closed", "all"];

/** Each service writes its own number: GitHub `#12`, GitLab `!12`. */
const numberLabel = (host: RemoteHost, iid: number) =>
  `${host === "github" ? "#" : "!"}${iid}`;

/** A repo without a remote on this service is a normal state, not a failure —
 *  its error is rendered plainly rather than as a crash. */
const isBenign = isMissingRemote;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface MergeRequestsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Which service the project's remote is on. Both speak the same shapes;
   *  only the endpoints and the wording differ. */
  host: RemoteHost;
  path: string | null;
  /** Handed the conflicted file list when a merge stops — the conflict UI
   *  lives outside this panel. */
  onConflicts?: (files: string[]) => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
}

export function MergeRequestsPanel({
  open,
  onClose,
  host,
  path,
  onConflicts,
  embedded,
}: MergeRequestsPanelProps) {
  const [state, setState] = useState<MrState>("opened");
  const [selectedIid, setSelectedIid] = useState<number | null>(null);

  const repo = path ?? "";
  // `.data` is undefined until the CLI probe lands — only a definite
  // "not logged in" should replace the list with the prompt.
  const forgeClis = useForgeCliStatus().data;
  const hasToken = forgeClis
    ? (forgeClis.find((c) => c.id === host)?.authenticated ?? false)
    : true;
  const qc = useQueryClient();
  const mrsQuery = useForgeMrs(host, repo, state);
  const mrs = mrsQuery.data ?? [];
  const selected = mrs.find((mr) => mr.iid === selectedIid) ?? null;

  const back = () => setSelectedIid(null);

  return (
    <SidePanel
      storageKey="mergeRequests"
      open={open}
      embedded={embedded}
      onClose={onClose}
      flushHeader={selectedIid === null}
      header={
        selectedIid === null ? (
          <div className="flex items-center">
            {STATES.map((s) => (
              <TabButton
                key={s}
                active={state === s}
                onClick={() => setState(s)}
                label={s}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              onClick={back}
              title="Back to merge requests"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
            </button>
            <span className="truncate text-sm font-medium">
              Merge requests
            </span>
          </div>
        )
      }
      actions={
        selectedIid === null && (
          <button
            onClick={() => invalidateForge(qc)}
            title="Refresh"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )
      }
    >
      {!path ? (
        <Empty icon={<GitPullRequest className="size-5" />}>
          {`Open a project to see its ${FORGE_NOUN[host].one}s.`}
        </Empty>
      ) : !hasToken ? (
        <Empty icon={<GitPullRequest className="size-5" />}>
          {`Log in with ${host === "github" ? "gh" : "glab"} auth login to see ${FORGE_NOUN[host].one}s.`}
        </Empty>
      ) : selectedIid !== null ? (
        <MrDetail
          // Keyed so busy/error/expanded state never carries to the next MR.
          key={selectedIid}
          host={host}
          path={path}
          iid={selectedIid}
          fallback={selected}
          onConflicts={onConflicts}
        />
      ) : (
        <MrList host={host} query={mrsQuery} mrs={mrs} onSelect={setSelectedIid} />
      )}
    </SidePanel>
  );
}

/** Minimal slice of a react-query result — the panel only reacts to these. */
interface QueryLike {
  isPending: boolean;
  error: unknown;
}

function MrList({
  host,
  query,
  mrs,
  onSelect,
}: {
  host: RemoteHost;
  query: QueryLike;
  mrs: MergeRequest[];
  onSelect: (iid: number) => void;
}) {
  const noun = FORGE_NOUN[host].one;
  if (query.isPending) return <Empty>{`Loading ${noun}s…`}</Empty>;
  if (query.error) {
    return isBenign(query.error) ? (
      <Empty icon={<GitPullRequest className="size-5" />}>
        {`Not a ${host}.com repository.`}
      </Empty>
    ) : (
      <Empty>
        <span className="text-red-400">{String(query.error)}</span>
      </Empty>
    );
  }
  if (mrs.length === 0) return <Empty>{`No ${noun}s.`}</Empty>;

  return (
    <ul className="min-h-0 flex-1 overflow-auto">
      {mrs.map((mr) => (
        <li key={mr.iid}>
          <button
            onClick={() => onSelect(mr.iid)}
            className="flex w-full flex-col gap-1 border-b px-3 py-2 text-left hover:bg-accent"
          >
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
                {mr.title}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {numberLabel(host, mr.iid)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate font-mono">
                {mr.sourceBranch} → {mr.targetBranch}
              </span>
              {mr.draft && <Badge>Draft</Badge>}
              {mr.hasConflicts && <Badge warning>Conflicts</Badge>}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate">{mr.authorName}</span>
              <span>•</span>
              <span className="shrink-0">{relativeTime(mr.updatedAt)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MrDetail({
  path,
  host,
  iid,
  fallback,
  onConflicts,
}: {
  host: RemoteHost;
  path: string;
  iid: number;
  /** The list row, so branches render before the detail request lands. */
  fallback: MergeRequest | null;
  onConflicts?: (files: string[]) => void;
  /** Render inside the dock rather than as its own right aside. */
  embedded?: boolean;
}) {
  const detailQuery = useForgeMr(host, path, iid);
  const diffQuery = useForgeMrDiff(host, path, iid);
  const notesQuery = useForgeMrNotes(host, path, iid);
  const branchQuery = useGitBranch(path);
  const invalidateGit = useInvalidateGit();

  const [busy, setBusy] = useState<"checkout" | "merge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);

  const mr = detailQuery.data ?? fallback;
  // Merging the target in only makes sense once the MR's branch is checked out.
  const onSourceBranch = !!mr && branchQuery.data?.branch === mr.sourceBranch;

  const notes = useMemo(
    () => (notesQuery.data ?? []).filter((n) => !n.system),
    [notesQuery.data]
  );

  if (!mr) {
    if (detailQuery.error) {
      return <Empty>{String(detailQuery.error)}</Empty>;
    }
    return <Empty>Loading merge request…</Empty>;
  }

  async function checkout() {
    if (!mr || busy) return;
    setBusy("checkout");
    setError(null);
    try {
      await invoke("git_fetch", { path });
      await invoke("git_checkout_remote", { path, branch: mr.sourceBranch });
      invalidateGit(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function mergeTarget() {
    if (!mr || busy) return;
    setBusy("merge");
    setError(null);
    try {
      const result = await invoke<MergeOutcome>("git_merge", {
        path,
        gitRef: `origin/${mr.targetBranch}`,
      });
      invalidateGit(path);
      if (result.conflicted) onConflicts?.(result.files);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const toggleFile = (file: string) =>
    setExpanded((prev) =>
      prev.includes(file) ? prev.filter((f) => f !== file) : [...prev, file]
    );

  const files = diffQuery.data ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="space-y-2 border-b p-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-medium leading-snug">
            {mr.title}
          </h2>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {numberLabel(host, mr.iid)}
          </span>
          <button
            onClick={() => void openUrl(mr.webUrl)}
            title={`Open in ${FORGE_LABEL[host]}`}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono">
            {mr.sourceBranch} → {mr.targetBranch}
          </span>
          {mr.draft && <Badge>Draft</Badge>}
          {mr.hasConflicts && <Badge warning>Conflicts</Badge>}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{mr.authorName}</span>
          <span>•</span>
          <span>{relativeTime(mr.updatedAt)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
        <ActionButton
          icon={
            busy === "checkout" ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )
          }
          label="Checkout"
          title={`Fetch and check out ${mr.sourceBranch}`}
          disabled={busy !== null}
          onClick={() => void checkout()}
        />
        <ActionButton
          icon={
            busy === "merge" ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <GitMerge className="size-3.5" />
            )
          }
          label={`Merge ${mr.targetBranch} into this branch`}
          title={
            onSourceBranch
              ? `Merge origin/${mr.targetBranch} into ${mr.sourceBranch}`
              : `Check out ${mr.sourceBranch} first`
          }
          disabled={busy !== null || !onSourceBranch}
          onClick={() => void mergeTarget()}
        />
      </div>

      {error && (
        <p className="whitespace-pre-wrap border-b p-2 text-[11px] text-red-400">
          {error}
        </p>
      )}

      {detailQuery.data?.description && (
        <p className="whitespace-pre-wrap border-b p-3 text-xs leading-relaxed text-muted-foreground">
          {detailQuery.data.description}
        </p>
      )}

      <SectionHeader
        label="Changed files"
        count={files.length}
        loading={diffQuery.isPending}
      />
      {diffQuery.error && (
        <p className="px-3 py-1.5 text-[11px] text-red-400">
          {String(diffQuery.error)}
        </p>
      )}
      {files.map((file) => {
        const name = file.newPath || file.oldPath;
        const isOpen = expanded.includes(name);
        return (
          <div key={name} className="border-b">
            <button
              onClick={() => toggleFile(name)}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-accent"
              title={name}
            >
              {isOpen ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {file.newFile && <Badge>new</Badge>}
              {file.deletedFile && <Badge warning>deleted</Badge>}
              {file.renamedFile && <Badge>renamed</Badge>}
            </button>
            {isOpen && <ReadOnlyDiff text={file.diff} lang={langFromPath(name)} />}
          </div>
        );
      })}

      <SectionHeader
        label="Discussion"
        count={notes.length}
        loading={notesQuery.isPending}
      />
      {notes.length === 0 && !notesQuery.isPending && (
        <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
          <MessageSquare className="size-3.5" />
          No comments.
        </p>
      )}
      {notes.map((note) => (
        <div key={note.id} className="border-b px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate font-medium text-foreground">
              {note.authorName}
            </span>
            <span>•</span>
            <span className="shrink-0">{relativeTime(note.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed">
            {note.body}
          </p>
        </div>
      ))}
    </div>
  );
}

/** True for unified-diff header lines that aren't source code. */
function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("@@") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  );
}

/** Memoized so expanding another file doesn't re-highlight this one's lines. */
const DiffLine = memo(function DiffLine({
  marker,
  code,
  lang,
  tint,
}: {
  marker: string;
  code: string;
  lang: string | null;
  tint: string;
}) {
  return (
    <div className={cn("border-l-2 border-transparent pr-2", tint)}>
      <span className="inline-block w-5 shrink-0 select-none text-center opacity-40">
        {marker}
      </span>
      <span dangerouslySetInnerHTML={{ __html: highlightCode(code, lang) || " " }} />
    </div>
  );
});

function HunkBody({ text, lang }: { text: string; lang: string | null }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        if (line === "")
          return (
            <div key={i} className="border-l-2 border-transparent pl-5">
              {" "}
            </div>
          );
        if (isDiffMeta(line)) {
          return (
            <div
              key={i}
              className="border-l-2 border-transparent pl-5 pr-2 text-muted-foreground"
            >
              {line}
            </div>
          );
        }
        const c = line[0];
        const tint =
          c === "+"
            ? "border-emerald-500/50 bg-emerald-500/15"
            : c === "-"
              ? "border-red-500/50 bg-red-500/15"
              : "";
        return (
          <DiffLine
            key={i}
            marker={c === "+" || c === "-" ? c : " "}
            code={line.slice(1)}
            lang={lang}
            tint={tint}
          />
        );
      })}
    </>
  );
}

/** The same hunk rendering ChangesPanel uses, without the apply actions —
 *  an MR's diff belongs to the server, not the working tree. */
function ReadOnlyDiff({ text, lang }: { text: string; lang: string | null }) {
  const parsed = useMemo(() => parseDiff(text), [text]);

  if (!text.trim()) {
    return <div className="p-3 text-xs text-muted-foreground">No diff to show.</div>;
  }
  if (parsed.hunks.length === 0) {
    return (
      <pre className="overflow-x-auto whitespace-pre py-1 font-mono text-xs leading-relaxed">
        <div className="w-max min-w-full">
          <HunkBody text={text} lang={lang} />
        </div>
      </pre>
    );
  }

  return (
    <div className="font-mono text-xs leading-relaxed">
      {parsed.hunks.map((hunk) => (
        <div key={hunk.offset}>
          <div className="border-y border-sky-500/20 bg-sky-500/10 py-0.5 pl-5 pr-2">
            <span className="truncate text-sky-400">{hunk.header}</span>
          </div>
          <pre className="overflow-x-auto whitespace-pre py-1">
            <div className="w-max min-w-full">
              <HunkBody text={hunk.text.slice(hunk.header.length + 1)} lang={lang} />
            </div>
          </pre>
        </div>
      ))}
    </div>
  );
}

function SectionHeader({
  label,
  count,
  loading,
}: {
  label: string;
  count: number;
  loading: boolean;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between bg-card px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{label}</span>
      {loading ? (
        <RefreshCw className="size-3 animate-spin" />
      ) : (
        <span className="tabular-nums">{count}</span>
      )}
    </div>
  );
}

function Badge({
  warning,
  children,
}: {
  warning?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 text-[10px] font-medium",
        warning
          ? "bg-amber-500/15 text-amber-400"
          : "bg-secondary text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

function ActionButton({
  icon,
  label,
  title,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded px-2 py-1.5 text-xs capitalize",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

function Empty({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}
