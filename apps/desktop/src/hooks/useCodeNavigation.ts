import { useEffect, useState, type RefObject } from "react";
import type { EditorHandle } from "@/components/editor/CodeEditor";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { clickTargetAt } from "@/lib/clickTarget";
import type { DefMatch } from "@/types";

interface Location {
  path: string;
  line: number;
}

interface NavigationOptions {
  projectPath: string;
  /** Currently open file, or null when the editor is empty. */
  selected: string | null;
  /** Its full text, including unsaved edits. */
  text: string;
  /** Set when the target file's text has arrived and can be revealed. */
  ready: boolean;
  open: (path: string) => void;
  editor: RefObject<EditorHandle | null>;
}

/**
 * ⌘-click go-to-definition: follows import specifiers, resolves symbols to
 * their declaration, reveals the target line, and keeps a back-stack. Ambiguous
 * symbols surface as a picker for the caller to render.
 */
export function useCodeNavigation({
  projectPath,
  selected,
  text,
  ready,
  open,
  editor,
}: NavigationOptions) {
  const [history, setHistory] = useState<Location[]>([]);
  const [reveal, setReveal] = useState<Location | null>(null);
  const [picker, setPicker] = useState<{ symbol: string; matches: DefMatch[] } | null>(
    null
  );
  const [seeking, setSeeking] = useState(false);

  /** Open a file at a line. `record` pushes the current spot onto the stack. */
  function jumpTo(path: string, line: number, record = true) {
    if (record && selected) {
      setHistory((h) => [
        ...h,
        { path: selected, line: editor.current?.currentLine() ?? 1 },
      ]);
    }
    setPicker(null);
    open(path);
    setReveal({ path, line });
  }

  function goBack() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    jumpTo(prev.path, prev.line, false);
  }

  /** ⌘/Ctrl-click: follow an import specifier, else look up the symbol. */
  async function followAt(index: number) {
    if (!selected || seeking) return;
    const target = clickTargetAt(text, index);
    if (!target) return;
    setSeeking(true);
    try {
      if (target.kind === "import") {
        const hit = await invoke<string | null>("resolve_import", {
          root: projectPath,
          from: selected,
          spec: target.spec,
        });
        if (hit) jumpTo(hit, 1);
        else toast.message(`Can't resolve "${target.spec}"`);
        return;
      }
      const matches = await invoke<DefMatch[]>("find_definition", {
        root: projectPath,
        symbol: target.name,
        from: selected,
      });
      // A lone hit on the line just clicked means we're already there.
      const clickedLine = text.slice(0, index).split("\n").length;
      const elsewhere = matches.filter(
        (m) => !(m.path === selected && m.line === clickedLine)
      );
      if (elsewhere.length === 0) {
        toast.message(`No definition found for "${target.name}"`);
      } else if (elsewhere.length === 1) {
        jumpTo(elsewhere[0].path, elsewhere[0].line);
      } else {
        setPicker({ symbol: target.name, matches: elsewhere });
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSeeking(false);
    }
  }

  // Reveal the target line once the file's text is in the buffer. Runs after
  // the async read, so it can't be done in the click handler.
  useEffect(() => {
    if (!reveal || reveal.path !== selected || !ready) return;
    editor.current?.revealLine(reveal.line);
    setReveal(null);
  }, [reveal, selected, ready, text, editor]);

  return {
    canGoBack: history.length > 0,
    seeking,
    picker,
    closePicker: () => setPicker(null),
    jumpTo,
    goBack,
    followAt,
  };
}
