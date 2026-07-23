import { useEffect, useImperativeHandle, useRef, type RefObject } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { languageFor } from "@/lib/codemirrorLang";

/** What the pane can ask of the editor once it's mounted. */
export interface EditorHandle {
  /** 1-based line the cursor is on, for the navigation back-stack. */
  currentLine: () => number;
  /** Scroll a 1-based line into view and select it. */
  revealLine: (line: number) => void;
  focus: () => void;
}

interface CodeEditorProps {
  /** File path — picks the language mode. */
  path: string | null;
  value: string;
  onChange: (next: string) => void;
  fontFamily: string;
  fontSize: number;
  handle: RefObject<EditorHandle | null>;
  /** ⌘/Ctrl-click on a document position. */
  onFollow: (pos: number) => void;
  /** Pointer resting over the document, for the definition hover card. */
  onHover: (pos: number | null, clientX: number, clientY: number) => void;
  onHoverEnd: () => void;
  onSave: () => void;
  onBack: () => void;
  onHistory: () => void;
}

/**
 * CodeMirror 6 host for the editor pane. CM owns the document, undo history,
 * selection and in-buffer search; the pane keeps ownership of the file buffer,
 * so edits flow out through `onChange` and file switches flow back in as a
 * whole-document replace.
 */
export function CodeEditor({
  path,
  value,
  onChange,
  fontFamily,
  fontSize,
  handle,
  onFollow,
  onHover,
  onHoverEnd,
  onSave,
  onBack,
  onHistory,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const theme = useRef(new Compartment());
  // Callbacks live in a ref so the view is built once and never torn down for
  // an identity change — rebuilding it would drop undo history and scroll.
  const callbacks = useRef({ onChange, onFollow, onHover, onHoverEnd, onSave, onBack, onHistory });
  callbacks.current = { onChange, onFollow, onHover, onHoverEnd, onSave, onBack, onHistory };

  useEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        history(),
        indentOnInput(),
        indentUnit.of("  "),
        bracketMatching(),
        search({ top: true }),
        highlightSelectionMatches(),
        oneDark,
        theme.current.of(themeFor(fontFamily, fontSize)),
        language.current.of([]),
        keymap.of([
          { key: "Mod-s", run: () => (callbacks.current.onSave(), true) },
          { key: "Mod-[", run: () => (callbacks.current.onBack(), true) },
          { key: "Mod-Alt-h", run: () => (callbacks.current.onHistory(), true) },
          ...searchKeymap,
          ...foldKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.current.onChange(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          mousedown: (event, editor) => {
            if (!event.metaKey && !event.ctrlKey) return false;
            const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            event.preventDefault();
            callbacks.current.onFollow(pos);
            return true;
          },
          mousemove: (event, editor) => {
            const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            callbacks.current.onHover(pos, event.clientX, event.clientY);
            return false;
          },
          mouseleave: () => {
            callbacks.current.onHoverEnd();
            return false;
          },
          scroll: () => {
            callbacks.current.onHoverEnd();
            return false;
          },
        }),
      ],
    });

    view.current = new EditorView({ state, parent: host.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // Built once; every changing input is applied through a compartment below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull the buffer in when it changed outside CM (file switch, save, revert).
  useEffect(() => {
    const editor = view.current;
    if (!editor || value === editor.state.doc.toString()) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    void languageFor(path).then((support) => {
      const editor = view.current;
      if (cancelled || !editor) return;
      editor.dispatch({
        effects: language.current.reconfigure(support ? [support] : []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    view.current?.dispatch({
      effects: theme.current.reconfigure(themeFor(fontFamily, fontSize)),
    });
  }, [fontFamily, fontSize]);

  useImperativeHandle(handle, () => ({
    currentLine: () => {
      const editor = view.current;
      if (!editor) return 1;
      return editor.state.doc.lineAt(editor.state.selection.main.head).number;
    },
    revealLine: (line: number) => {
      const editor = view.current;
      if (!editor) return;
      const target = Math.min(Math.max(line, 1), editor.state.doc.lines);
      const { from, to } = editor.state.doc.line(target);
      editor.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
      editor.focus();
    },
    focus: () => view.current?.focus(),
  }));

  return (
    <div
      ref={host}
      className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
    />
  );
}

function themeFor(fontFamily: string, fontSize: number): Extension {
  return EditorView.theme({
    "&": { height: "100%", fontSize: `${fontSize}px`, backgroundColor: "transparent" },
    ".cm-scroller": { fontFamily, lineHeight: "1.6" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.04)" },
  });
}
