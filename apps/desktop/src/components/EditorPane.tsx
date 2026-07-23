import { useEffect, useRef, useState } from "react";
import { ArrowLeft, History, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path";
import { FileFinder } from "@/components/FileFinder";
import { FileTree, FileTypeIcon } from "@/components/editor/FileTree";
import { CodeEditor, type EditorHandle } from "@/components/editor/CodeEditor";
import { SearchPanel } from "@/components/editor/SearchPanel";
import { onSearchRequest, takeSearchRequest } from "@/lib/searchRequest";
import { HoverCard } from "@/components/editor/HoverCard";
import { GitRewind } from "@/components/GitRewind";
import { DefinitionPicker } from "@/components/editor/DefinitionPicker";
import { useFileBuffers } from "@/hooks/useFileBuffers";
import { useCodeNavigation } from "@/hooks/useCodeNavigation";
import { useSymbolHover } from "@/hooks/useSymbolHover";

interface EditorPaneProps {
  projectPath: string;
  fontFamily: string;
  fontSize: number;
  /** Only the focused editor tab claims ⌘K from the global command palette. */
  active: boolean;
}

/**
 * File browser + CodeMirror editor. ⌘S saves, ⌘-click jumps to a definition,
 * ⌘[ goes back, ⌘K opens the file finder, ⌘F searches the open buffer, and
 * hovering a symbol previews where it's declared.
 */
export function EditorPane({
  projectPath,
  fontFamily,
  fontSize,
  active,
}: EditorPaneProps) {
  const [finderOpen, setFinderOpen] = useState(false);
  // A ⇧⌘F issued before this pane existed (the shortcut opens the editor
  // first) lands here on mount.
  const [side, setSide] = useState<"files" | "search">(() =>
    takeSearchRequest() ? "search" : "files"
  );
  const [searchFocus, setSearchFocus] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef<EditorHandle | null>(null);

  const files = useFileBuffers(projectPath);
  const { selected, text, dirty, dirtyPaths, saving, save, edit } = files;

  const hover = useSymbolHover({
    projectPath,
    selected,
    text,
    invalidateOn: files.savedAt,
  });

  const nav = useCodeNavigation({
    projectPath,
    selected,
    text,
    ready: !files.status.isPending,
    open: files.select,
    editor: editorRef,
  });

  // ⌘K opens the file finder instead of the global command palette while this
  // editor tab is focused. Capture phase + stopPropagation beats the window
  // handler in useShortcuts, which listens on the bubble phase.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        e.stopPropagation();
        hover.cancel();
        setFinderOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  // ⇧⌘F anywhere routes here: show the Search tab and (re)focus its input.
  useEffect(
    () =>
      onSearchRequest(() => {
        takeSearchRequest();
        setSide("search");
        setSearchFocus((n) => n + 1);
      }),
    []
  );

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1">
          <SideTab active={side === "files"} onClick={() => setSide("files")}>
            Files
          </SideTab>
          <SideTab active={side === "search"} onClick={() => setSide("search")}>
            Search
          </SideTab>
        </div>
        {side === "files" ? (
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <FileTree
              root={projectPath}
              name={basename(projectPath)}
              selected={selected}
              dirtyPaths={dirtyPaths}
              onSelect={files.select}
            />
          </div>
        ) : (
          <SearchPanel
            projectPath={projectPath}
            focusToken={searchFocus}
            onOpenHit={(rel, line) => nav.jumpTo(`${projectPath}/${rel}`, line)}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-9 shrink-0 items-center justify-between gap-2 border-b px-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {nav.canGoBack && (
              <button
                onClick={nav.goBack}
                className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
                title="Back (⌘[)"
              >
                <ArrowLeft className="size-3.5" />
              </button>
            )}
            {selected && <FileTypeIcon name={basename(selected)} />}
            <span className="truncate">
              {selected ? selected.replace(projectPath + "/", "") : "No file open"}
            </span>
            {dirty && <span className="shrink-0 text-primary">●</span>}
          </span>
          {nav.seeking && (
            <span className="shrink-0 text-xs text-muted-foreground">Finding…</span>
          )}
          {selected && (
            <button
              onClick={() => setHistoryOpen(true)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title="File history (⌥⌘H)"
            >
              <History className="size-3.5" />
            </button>
          )}
          {selected && (
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
              title="Save (⌘S)"
            >
              <Save className="size-3.5" />
              {saving ? "Saving…" : "Save"}
            </button>
          )}

          {nav.picker && (
            <DefinitionPicker
              symbol={nav.picker.symbol}
              matches={nav.picker.matches}
              projectPath={projectPath}
              onPick={(m) => nav.jumpTo(m.path, m.line)}
              onClose={nav.closePicker}
            />
          )}
        </header>

        {!selected ? (
          <Placeholder>Pick a file from the tree to view and edit it.</Placeholder>
        ) : files.status.isError ? (
          <Placeholder tone="error">{String(files.status.error)}</Placeholder>
        ) : files.status.isPending ? (
          <Placeholder>Loading…</Placeholder>
        ) : (
          <CodeEditor
            path={selected}
            value={text}
            onChange={edit}
            fontFamily={fontFamily}
            fontSize={fontSize}
            handle={editorRef}
            onFollow={(pos) => void nav.followAt(pos)}
            onHover={hover.onHover}
            onHoverEnd={hover.cancel}
            onSave={() => void save()}
            onBack={nav.goBack}
            onHistory={() => setHistoryOpen(true)}
          />
        )}
      </div>

      {finderOpen && (
        <FileFinder
          projectPath={projectPath}
          onPick={(rel) => {
            setFinderOpen(false);
            nav.jumpTo(`${projectPath}/${rel}`, 1);
          }}
          onClose={() => setFinderOpen(false)}
        />
      )}

      {historyOpen && selected && (
        <GitRewind
          projectPath={projectPath}
          file={selected.replace(`${projectPath}/`, "")}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {hover.hover && (
        <HoverCard
          hover={hover.hover}
          projectPath={projectPath}
          onJump={() => nav.jumpTo(hover.hover!.info.path, hover.hover!.info.line)}
        />
      )}
    </div>
  );
}

/** Left-column tab switch: file tree vs project search. */
function SideTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded px-2 py-1 text-xs font-medium",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Placeholder({
  tone,
  children,
}: {
  tone?: "error";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center p-4 text-xs",
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {children}
    </div>
  );
}
