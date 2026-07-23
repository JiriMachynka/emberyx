import { useEffect, useState, type RefObject } from "react";
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
  lineHeight: number;
  areaRef: RefObject<HTMLTextAreaElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
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
  lineHeight,
  areaRef,
  scrollRef,
}: NavigationOptions) {
  const [history, setHistory] = useState<Location[]>([]);
  const [reveal, setReveal] = useState<Location | null>(null);
  const [picker, setPicker] = useState<{ symbol: string; matches: DefMatch[] } | null>(
    null
  );
  const [seeking, setSeeking] = useState(false);

  /** 1-based line the caret currently sits on, for the back-stack. */
  function caretLine(): number {
    const el = areaRef.current;
    if (!el) return 1;
    return text.slice(0, el.selectionStart).split("\n").length;
  }

  /** Open a file at a line. `record` pushes the current spot onto the stack. */
  function jumpTo(path: string, line: number, record = true) {
    if (record && selected) {
      setHistory((h) => [...h, { path: selected, line: caretLine() }]);
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

  // Scroll + select the target line once the file's text is in the buffer.
  // Runs after the async read, so it can't be done in the click handler.
  useEffect(() => {
    if (!reveal || reveal.path !== selected || !ready) return;
    const area = areaRef.current;
    const scroller = scrollRef.current;
    if (!area || !scroller) return;
    const lines = text.split("\n");
    const start = lines
      .slice(0, reveal.line - 1)
      .reduce((n, l) => n + l.length + 1, 0);
    area.focus();
    area.setSelectionRange(start, start + (lines[reveal.line - 1]?.length ?? 0));
    scroller.scrollTop = Math.max(
      0,
      (reveal.line - 1) * lineHeight - scroller.clientHeight / 3
    );
    setReveal(null);
  }, [reveal, selected, ready, text, lineHeight, areaRef, scrollRef]);

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
