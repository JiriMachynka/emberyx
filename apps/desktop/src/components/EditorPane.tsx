import { useEffect, useRef, useState } from "react";
import { ArrowLeft, History, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { CodeEditor, type EditorHandle } from "@/components/editor/CodeEditor";
import { SearchPanel } from "@/components/editor/SearchPanel";
import { onSearchRequest, takeSearchRequest } from "@/lib/searchRequest";
import { onOpenFileRequest, takeOpenFileRequest } from "@/lib/openFileRequest";
import { HoverCard } from "@/components/editor/HoverCard";
import { GitRewind } from "@/components/GitRewind";
import { DefinitionPicker } from "@/components/editor/DefinitionPicker";
import { useFileBuffers } from "@/hooks/useFileBuffers";
import { useCodeNavigation } from "@/hooks/useCodeNavigation";
import { useSymbolHover } from "@/hooks/useSymbolHover";

const TREE_MIN = 180;
const TREE_MAX = 480;
const TREE_KEY = "emberyx.editor.tree.width";

const initialTreeWidth = (): number => {
  const v = Number(localStorage.getItem(TREE_KEY));
  return v >= TREE_MIN && v <= TREE_MAX ? v : 256;
};

interface EditorPaneProps {
  projectPath: string;
  fontFamily: string;
  fontSize: number;
  /** Wrap long lines instead of scrolling sideways. */
  wordWrap: boolean;
  onClose?: () => void;
}

/**
 * CodeMirror editor overlay. The file tree lives in Explorer; ⌘P finds a file.
 * ⌘S saves, ⌘-click jumps to a definition, ⌘[ goes back, ⌘F searches the open
 * buffer, ⇧⌘F searches the project, and hovering a symbol previews where it's
 * declared.
 */
export function EditorPane({
  projectPath,
  fontFamily,
  fontSize,
  wordWrap,
  onClose,
}: EditorPaneProps) {
  // A ⇧⌘F issued before this pane existed (the shortcut opens the editor
  // first) lands here on mount.
  const [searchOpen, setSearchOpen] = useState(() => takeSearchRequest());
  const [searchFocus, setSearchFocus] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [treeWidth, setTreeWidth] = useState(initialTreeWidth);
  const editorRef = useRef<EditorHandle | null>(null);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    let last = startW;
    const onMove = (ev: MouseEvent) => {
      last = Math.min(TREE_MAX, Math.max(TREE_MIN, startW + ev.clientX - startX));
      setTreeWidth(last);
    };
    const onUp = () => {
      localStorage.setItem(TREE_KEY, String(last));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const files = useFileBuffers(projectPath);
  const { selected, text, dirty, saving, save, edit } = files;

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

  // ⇧⌘F anywhere routes here: show project search and (re)focus its input.
  useEffect(
    () =>
      onSearchRequest(() => {
        takeSearchRequest();
        setSearchOpen(true);
        setSearchFocus((n) => n + 1);
      }),
    []
  );

  // A file reference clicked in the chat. The click opens this tab too, so the
  // pane may not have existed when the request fired — hence the mount-time
  // consume alongside the live listener.
  useEffect(() => {
    const show = (path: string) => {
      setSearchOpen(false);
      files.select(path);
    };
    const pending = takeOpenFileRequest();
    if (pending !== null) show(pending);
    return onOpenFileRequest((path) => {
      takeOpenFileRequest();
      show(path);
    });
    // Subscribed once: `select` is a setState function, stable for the pane's
    // lifetime, so re-subscribing per render would only churn listeners.
  }, []);

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden">
      {searchOpen && (
        <div
          className="relative flex shrink-0 flex-col border-r"
          style={{ width: treeWidth }}
        >
          <div
            onMouseDown={startResize}
            className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
            title="Drag to resize"
          />
          <SearchPanel
            projectPath={projectPath}
            focusToken={searchFocus}
            onOpenHit={(rel, line) => nav.jumpTo(`${projectPath}/${rel}`, line)}
            onClose={() => setSearchOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-10 shrink-0 items-center justify-between gap-2 border-b px-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {nav.canGoBack && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={nav.goBack}
                title="Back (⌘[)"
                className="text-muted-foreground"
              >
                <ArrowLeft />
              </Button>
            )}
            {selected && <FileTypeIcon path={selected} />}
            <span className="truncate">
              {selected ? selected.replace(projectPath + "/", "") : "No file open"}
            </span>
            {dirty && <span className="shrink-0 text-primary">●</span>}
          </span>
          {nav.seeking && (
            <span className="shrink-0 text-xs text-muted-foreground">Finding…</span>
          )}
          {selected && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setHistoryOpen(true)}
              title="File history (⌥⌘H)"
              className="text-muted-foreground"
            >
              <History />
            </Button>
          )}
          {selected && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || saving}
              title="Save (⌘S)"
              className="text-muted-foreground"
            >
              <Save />
              {saving ? "Saving…" : "Save"}
            </Button>
          )}
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              title="Close editor"
              className="text-muted-foreground"
            >
              <X />
            </Button>
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
          <Placeholder>Pick a file in Explorer, or press ⌘P to search.</Placeholder>
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
            wordWrap={wordWrap}
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
