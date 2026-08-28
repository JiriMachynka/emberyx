import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isLookupWorthy, wordAt } from "@/lib/clickTarget";
import { highlightCached, langFromPath } from "@/lib/highlight";
import type { HoverInfo } from "@/types";

/** A resolved hover, with its snippet already rendered to hljs token spans. */
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
    // Highlighting is synchronous and shares the transcript's LRU, so a
    // re-hover paints from cache. It also drops the app's second highlighter:
    // this card used to name the language with highlight.js and paint it with
    // shiki.
    const html = highlightCached(info.code, langFromPath(info.path));
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
