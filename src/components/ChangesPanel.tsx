import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { diffLines } from "diff";
import { X, FileDiff, RefreshCw, GitBranch, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import type { Change } from "@/lib/changes";
import type { GitFile } from "@/types";

/** Colorize a raw unified diff by line prefix. */
function UnifiedDiff({ text }: { text: string }) {
  if (!text.trim()) {
    return (
      <div className="p-3 text-xs text-muted-foreground">No diff to show.</div>
    );
  }
  return (
    <pre className="overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs leading-relaxed">
      {text.split("\n").map((line, i) => {
        const c = line[0];
        const cls =
          line.startsWith("+++") || line.startsWith("---")
            ? "text-muted-foreground"
            : c === "+"
              ? "bg-emerald-500/15 text-emerald-300"
              : c === "-"
                ? "bg-red-500/15 text-red-300"
                : line.startsWith("@@")
                  ? "text-sky-400"
                  : "text-muted-foreground";
        return (
          <div key={i} className={cn("px-1", cls)}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** jsdiff view of an agent edit (old vs new). */
function EditDiff({ change }: { change: Change }) {
  const parts = diffLines(change.oldText, change.newText);
  return (
    <pre className="overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs leading-relaxed">
      {parts.map((part, i) =>
        part.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={cn(
                "px-1",
                part.added
                  ? "bg-emerald-500/15 text-emerald-300"
                  : part.removed
                    ? "bg-red-500/15 text-red-300"
                    : "text-muted-foreground"
              )}
            >
              <span className="select-none opacity-50">
                {part.added ? "+" : part.removed ? "-" : " "}{" "}
              </span>
              {line}
            </div>
          ))
      )}
    </pre>
  );
}

interface ChangesPanelProps {
  projectPath: string;
  changes: Change[];
  onClose: () => void;
}

export function ChangesPanel({
  projectPath,
  changes,
  onClose,
}: ChangesPanelProps) {
  const [tab, setTab] = useState<"git" | "agent">("git");

  // Git tab state.
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitSel, setGitSel] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState("");

  // Agent tab state.
  const [agentSelId, setAgentSelId] = useState<number | null>(null);
  const agentSel =
    changes.find((c) => c.id === agentSelId) ?? changes[changes.length - 1];

  const loadGit = useCallback(() => {
    invoke<GitFile[]>("git_changes", { path: projectPath })
      .then(setGitFiles)
      .catch((e) => console.error("git_changes failed:", e));
  }, [projectPath]);

  useEffect(() => {
    loadGit();
  }, [loadGit]);

  function selectGit(f: GitFile) {
    setGitSel(f.path);
    setGitDiff("");
    invoke<string>("git_file_diff", {
      path: projectPath,
      file: f.path,
      untracked: f.untracked,
    })
      .then(setGitDiff)
      .catch((e) => console.error("git_file_diff failed:", e));
  }

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l bg-card">
      <header className="flex h-9 shrink-0 items-center justify-between border-b pl-1 pr-2">
        <div className="flex items-center">
          <TabButton
            active={tab === "git"}
            onClick={() => setTab("git")}
            icon={<GitBranch className="size-3.5" />}
            label={`Git${gitFiles.length ? ` (${gitFiles.length})` : ""}`}
          />
          <TabButton
            active={tab === "agent"}
            onClick={() => setTab("agent")}
            icon={<Bot className="size-3.5" />}
            label={`Agent${changes.length ? ` (${changes.length})` : ""}`}
          />
        </div>
        <div className="flex items-center gap-1">
          {tab === "git" && (
            <button
              onClick={loadGit}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>

      {tab === "git" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {gitFiles.length === 0 ? (
            <Empty icon={<GitBranch className="size-5" />}>
              No working-tree changes (or not a git repo).
            </Empty>
          ) : (
            <>
              <ul className="max-h-40 shrink-0 overflow-auto border-b">
                {gitFiles.map((f) => (
                  <li key={f.path}>
                    <button
                      onClick={() => selectGit(f)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                        gitSel === f.path && "bg-secondary"
                      )}
                      title={f.path}
                    >
                      <span
                        className={cn(
                          "w-5 shrink-0 text-center font-mono text-[10px]",
                          f.untracked ? "text-emerald-400" : "text-amber-400"
                        )}
                      >
                        {f.untracked ? "U" : f.status.trim() || "M"}
                      </span>
                      <span className="flex-1 truncate">{f.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="min-h-0 flex-1 overflow-auto">
                {gitSel ? (
                  <UnifiedDiff text={gitDiff} />
                ) : (
                  <Empty>Select a file to see its diff.</Empty>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {changes.length === 0 ? (
            <Empty icon={<FileDiff className="size-5" />}>
              Edits the agent makes show up here.
            </Empty>
          ) : (
            <>
              <ul className="max-h-40 shrink-0 overflow-auto border-b">
                {[...changes].reverse().map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => setAgentSelId(c.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                        agentSel?.id === c.id && "bg-secondary"
                      )}
                    >
                      <span className="rounded bg-secondary px-1 text-[10px] text-muted-foreground">
                        {c.tool}
                      </span>
                      <span className="flex-1 truncate">{basename(c.file)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {agentSel && (
                <div className="min-h-0 flex-1 overflow-auto">
                  <div className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">
                    {agentSel.file}
                  </div>
                  <EditDiff change={agentSel} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2 py-1 text-xs",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
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
