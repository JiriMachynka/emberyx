import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isLookupWorthy, wordAt } from "@/lib/clickTarget";
import { langFromPath } from "@/lib/highlight";
import { highlightSnippet } from "@/lib/shiki";
import type { HoverInfo } from "@/types";

/** A resolved hover, with its snippet already rendered by shiki. */
export interface Hover {
  symbol: string;
  info: HoverInfo;
  html: string;
  x: number;
  y: number;
}

/** How long the pointer must rest on a symbol before its definition is fetched. */
const HOVER_DELAY = 350;

interface HoverOptions {
  projectPath: string;
  selected: string | null;
  text: string;
  /** Counter that changes when files are written; clears the lookup cache. */
  invalidateOn: number;
}

/** Definition preview for the symbol under a resting pointer. CodeMirror maps
 *  the pointer to a document offset; this hook only decides what to look up. */
export function useSymbolHover({
  projectPath,
  selected,
  text,
  invalidateOn,
}: HoverOptions) {
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<number | null>(null);
  const word = useRef<string | null>(null);
  // Definition lookups are project-wide walks; remember what each symbol
  // resolved to so re-hovering the same name is instant.
  const cache = useRef(new Map<string, HoverInfo | null>());

  function cancel() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    word.current = null;
    setHover(null);
  }

  // Edits can move or rename declarations, so a save invalidates the cache.
  useEffect(() => {
    cache.current.clear();
  }, [invalidateOn]);

  async function resolve(symbol: string, x: number, y: number) {
    if (!selected) return;
    let info = cache.current.get(symbol);
    if (info === undefined) {
      info = await invoke<HoverInfo | null>("hover_info", {
        root: projectPath,
        symbol,
        from: selected,
      });
      cache.current.set(symbol, info);
    }
    // The pointer may have moved on while the lookup ran.
    if (!info || word.current !== symbol) return;
    const html = await highlightSnippet(info.code, langFromPath(info.path));
    if (word.current !== symbol) return;
    setHover({ symbol, info, html, x, y });
  }

  /** Called with the document offset under the pointer, or null when it isn't
   *  over any text. */
  function onHover(index: number | null, clientX: number, clientY: number) {
    const next = index === null ? "" : wordAt(text, index);
    if (next && next === word.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    setHover(null);
    if (!next || !isLookupWorthy(next)) {
      word.current = null;
      return;
    }
    word.current = next;
    timer.current = window.setTimeout(() => {
      void resolve(next, clientX, clientY);
    }, HOVER_DELAY);
  }

  return { hover, onHover, cancel };
}
