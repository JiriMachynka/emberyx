import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { AlertTriangle, Bot, Check, GitMerge, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/path";
import { languageFor } from "@/lib/codemirrorLang";
import {
  useGitConflictStages,
  useGitConflicts,
  useGitMergeState,
} from "@/lib/queries";

/** True when the buffer still carries `<<<<<<<` / `>>>>>>>` merge markers. */
function hasMarkers(text: string): boolean {
  return text.includes("<<<<<<<") && text.includes(">>>>>>>");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A CodeMirror host for one conflict stage. Built once per mount and fed new
 * text through a document replace, so typing in the merged pane never rebuilds
 * the view (which would drop undo history and scroll position).
 */
function StagePane({
  file,
  value,
  readOnly,
  onChange,
}: {
  file: string;
  value: string;
  readOnly: boolean;
  onChange?: (next: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // Held in a ref so a new callback identity never tears the view down.
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        oneDark,
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        language.current.of([]),
        keymap.of([...historyKeymap, ...defaultKeymap]),
        EditorView.theme({
          "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent" },
          ".cm-scroller": { lineHeight: "1.6" },
          ".cm-gutters": { backgroundColor: "transparent", border: "none" },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit.current?.(update.state.doc.toString());
        }),
      ],
    });

    view.current = new EditorView({ state, parent: host.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // Built once; changing inputs are applied through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull the buffer in when it changed outside CM ("Use ours" / "Use theirs").
  useEffect(() => {
    const editor = view.current;
    if (!editor || value === editor.state.doc.toString()) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      selection: { anchor: 0 },
    });
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    void languageFor(file).then((support) => {
      const editor = view.current;
      if (cancelled || !editor) return;
      editor.dispatch({
        effects: language.current.reconfigure(support ? [support] : []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div
      ref={host}
      className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
    />
  );
}

/** A stage that has no content on this side (add/add, delete/modify). */
function AbsentStage() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      (file absent on this side)
    </div>
  );
}

function PaneFrame({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b px-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** The three-pane resolver for one conflicted file. Remounted per file by its
 *  key, so the merged buffer never leaks from one file to the next. */
function Resolver({
  path,
  file,
  onResolved,
}: {
  path: string;
  file: string;
  onResolved: () => void;
}) {
  const { data: stages, isLoading, error } = useGitConflictStages(path, file);
  const [merged, setMerged] = useState("");
  const [confirmMarkers, setConfirmMarkers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const seeded = useRef(false);

  // Seeded during render, not in an effect: an effect lets the merged editor
  // mount empty and then receive the real text as a document change, which
  // leaves an undo step that wipes the buffer. The ref keeps a background
  // refetch from clobbering edits in progress.
  if (!seeded.current && stages) {
    seeded.current = true;
    setMerged(stages.merged);
  }

  const replaceWith = (next: string | null) => {
    setMerged(next ?? "");
    setConfirmMarkers(false);
  };

  const markResolved = async () => {
    if (hasMarkers(merged) && !confirmMarkers) {
      setConfirmMarkers(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await invoke("git_resolve", { path, file, content: merged });
      onResolved();
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="p-3 text-xs text-destructive">
        Could not read the conflict stages: {errorText(error)}
      </div>
    );
  }
  if (isLoading || !stages) {
    return <div className="p-3 text-xs text-muted-foreground">Loading stages…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 border-b">
        <PaneFrame
          label="Ours"
          action={
            <Button
              size="sm"
              variant="ghost"
              disabled={stages.ours === null}
              onClick={() => replaceWith(stages.ours)}
            >
              Use ours
            </Button>
          }
        >
          {stages.ours === null ? (
            <AbsentStage />
          ) : (
            <StagePane file={file} value={stages.ours} readOnly />
          )}
        </PaneFrame>
        <div className="w-px shrink-0 bg-border" />
        <PaneFrame
          label="Theirs"
          action={
            <Button
              size="sm"
              variant="ghost"
              disabled={stages.theirs === null}
              onClick={() => replaceWith(stages.theirs)}
            >
              Use theirs
            </Button>
          }
        >
          {stages.theirs === null ? (
            <AbsentStage />
          ) : (
            <StagePane file={file} value={stages.theirs} readOnly />
          )}
        </PaneFrame>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Merged
          </span>
          <Button size="sm" onClick={() => void markResolved()} disabled={busy}>
            <Check />
            {confirmMarkers ? "Resolve anyway" : "Mark resolved"}
          </Button>
        </div>
        {confirmMarkers && (
          <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300">
            <AlertTriangle className="size-3.5 shrink-0" />
            This buffer still contains conflict markers. Click again to resolve
            it as-is.
          </div>
        )}
        {failure && (
          <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {failure}
          </div>
        )}
        <StagePane file={file} value={merged} readOnly={false} onChange={setMerged} />
      </div>
    </div>
  );
}

/**
 * Full-canvas resolver for a merge in progress: the conflicted file list on the
 * left, a three-way ours/theirs/merged editor on the right, and the
 * abort/continue actions in the header.
 */
export function ConflictView({
  path,
  onDone,
  onAskClaude,
}: {
  path: string;
  onDone: () => void;
  onAskClaude?: (prompt: string) => void;
}) {
  const { data: conflicts, error: conflictsError } = useGitConflicts(path);
  const { data: merging } = useGitMergeState(path);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const files = conflicts ?? [];
  const active = selected && files.includes(selected) ? selected : (files[0] ?? null);

  // The conflict list, merge state and working-tree views all move together
  // after a resolve, so refresh the whole git namespace rather than guess keys.
  const refresh = () => qc.invalidateQueries({ queryKey: ["git"] });

  const askClaude = () => {
    const list = files.map((f) => `- ${f}`).join("\n");
    onAskClaude?.(
      `Resolve the git merge conflicts in ${path}.\n\n` +
        `Still conflicted:\n${list}\n\n` +
        `Edit each file in place: remove the <<<<<<<, ======= and >>>>>>> markers ` +
        `and leave one coherent version that preserves the intent of both sides. ` +
        `Do not run git add, do not commit, and do not continue or abort the merge — ` +
        `stop once the files are clean so I can review them.`
    );
  };

  const abort = async () => {
    if (!confirmAbort) {
      setConfirmAbort(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await invoke("git_merge_abort", { path });
      void refresh();
      onDone();
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await invoke("git_merge_continue", { path });
      void refresh();
      onDone();
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <GitMerge className="size-4 text-amber-400" />
        <span className="text-sm font-medium">Resolve conflicts</span>
        <span className="text-xs text-muted-foreground">
          {files.length === 0
            ? "all files resolved"
            : `${files.length} file${files.length === 1 ? "" : "s"} left`}
        </span>
        <div className="flex-1" />
        {onAskClaude && (
          <Button size="sm" variant="secondary" onClick={askClaude} disabled={files.length === 0}>
            <Bot />
            Resolve with Claude
          </Button>
        )}
        <Button
          size="sm"
          variant={confirmAbort ? "destructive" : "outline"}
          onClick={() => void abort()}
          onBlur={() => setConfirmAbort(false)}
          disabled={busy}
        >
          {confirmAbort ? "Discard the merge?" : "Abort merge"}
        </Button>
        <Button
          size="sm"
          onClick={() => void finish()}
          disabled={
            busy || files.length > 0 || merging === false || !!conflictsError
          }
        >
          Finish merge
        </Button>
        <Button size="icon" variant="ghost" onClick={onDone} aria-label="Close">
          <X />
        </Button>
      </header>

      {/* An unreadable conflict list would otherwise render as "all resolved"
          and arm Finish merge. */}
      {(failure || conflictsError) && (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {failure ?? errorText(conflictsError)}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ul className="w-64 shrink-0 overflow-auto border-r">
          {files.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Nothing left to resolve — finish the merge.
            </li>
          ) : (
            files.map((file) => (
              <li key={file}>
                <button
                  onClick={() => setSelected(file)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                    active === file && "bg-secondary"
                  )}
                  title={file}
                >
                  <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
                  <span className="flex-1 truncate">{basename(file)}</span>
                </button>
              </li>
            ))
          )}
        </ul>

        {active ? (
          <Resolver key={active} path={path} file={active} onResolved={refresh} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
            No conflicted files.
          </div>
        )}
      </div>
    </div>
  );
}
