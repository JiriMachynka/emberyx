import { useEffect, useMemo, useRef, useState } from "react";
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

/** Code-area padding, mirroring the px-3 py-2 on the <pre> and textarea. */
const PAD_X = 12;
const PAD_Y = 8;

interface HoverOptions {
  projectPath: string;
  selected: string | null;
  text: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** Counter that changes when files are written; clears the lookup cache. */
  invalidateOn: number;
}

/**
 * Definition preview for the symbol under a resting pointer. Pointer position
 * is mapped to a character offset from the monospace advance width — textareas
 * expose no caret-from-point API.
 */
export function useSymbolHover({
  projectPath,
  selected,
  text,
  fontFamily,
  fontSize,
  lineHeight,
  invalidateOn,
}: HoverOptions) {
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<number | null>(null);
  const word = useRef<string | null>(null);
  // Definition lookups are project-wide walks; remember what each symbol
  // resolved to so re-hovering the same name is instant.
  const cache = useRef(new Map<string, HoverInfo | null>());

  const charWidth = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return fontSize * 0.6;
    ctx.font = `${fontSize}px ${fontFamily}`;
    return ctx.measureText("M".repeat(50)).width / 50;
  }, [fontFamily, fontSize]);

  /** Character offset in `text` under a pointer event over the code area. */
  function indexAtPoint(offsetX: number, offsetY: number): number | null {
    const row = Math.floor((offsetY - PAD_Y) / lineHeight);
    const col = Math.floor((offsetX - PAD_X) / charWidth);
    if (row < 0 || col < 0) return null;
    const lines = text.split("\n");
    if (row >= lines.length || col > lines[row].length) return null;
    return lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0) + col;
  }

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

  function onMouseMove(e: React.MouseEvent<HTMLTextAreaElement>) {
    const index = indexAtPoint(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    const next = index === null ? "" : wordAt(text, index);
    if (next && next === word.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    setHover(null);
    if (!next || !isLookupWorthy(next)) {
      word.current = null;
      return;
    }
    word.current = next;
    const { clientX, clientY } = e;
    timer.current = window.setTimeout(() => {
      void resolve(next, clientX, clientY);
    }, HOVER_DELAY);
  }

  return { hover, onMouseMove, cancel };
}
