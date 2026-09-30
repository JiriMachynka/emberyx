import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPanelWidth, setPanelWidth, PANEL_MIN_WIDTH } from "@/lib/panels";

interface SidePanelProps {
  /** Distinct key per panel — its width is remembered under this name. */
  storageKey: string;
  /** Header's left slot: a title, or tab buttons. Embedded panels may leave it
   *  out entirely — the dock tab already names the surface, and an empty header
   *  row is a band of nothing above the content. */
  header?: React.ReactNode;
  /** Header's right slot, rendered before the close button. */
  actions?: React.ReactNode;
  onClose: () => void;
  /** When false the panel is hidden but stays mounted, so long-lived children
   *  (a dev server's terminal) keep running. Defaults to true. */
  open?: boolean;
  /** Padding-less header for panels whose header holds flush tab buttons. */
  flushHeader?: boolean;
  /** Render inside another panel: no aside/border/resize/close, just the header
   *  row + body filling the host. The host owns the frame. */
  embedded?: boolean;
  /** Widen the panel to at least this while set; restore the saved width when
   *  cleared. A review surface reads better wide, but a user who dragged the
   *  panel wider than this keeps their width — widening never shrinks. */
  suggestedWidth?: number | null;
  children: React.ReactNode;
}

/** The colour painted at an element's right edge: the first background under
 *  that point. Sampled clear of the 8px resize handle that overhangs it. */
const edgeColor = (el: HTMLElement): string => {
  const rect = el.getBoundingClientRect();
  let node = document.elementFromPoint?.(
    rect.right - 12,
    rect.top + rect.height / 2
  );
  while (node && node !== document.documentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
      return color;
    }
    node = node.parentElement;
  }
  return "transparent";
};

/**
 * The shell every right-hand panel shares: a bordered aside with a drag handle
 * on its left edge, a fixed-height header, and a scrollable body. Width is
 * clamped to the window and persisted per panel.
 */
export function SidePanel({
  storageKey,
  header,
  actions,
  onClose,
  open = true,
  flushHeader = false,
  embedded = false,
  suggestedWidth = null,
  children,
}: SidePanelProps) {
  const [width, setWidth] = useState(() => getPanelWidth(storageKey));
  const asideRef = useRef<HTMLElement>(null);
  // The width the panel had before a suggestion widened it; -1 marks "already
  // wide enough", so clearing the suggestion restores nothing.
  const widenedFrom = useRef<number | null>(null);

  useEffect(() => {
    if (embedded) return;
    if (suggestedWidth != null) {
      if (widenedFrom.current !== null) return;
      if (width >= suggestedWidth) {
        widenedFrom.current = -1;
        return;
      }
      widenedFrom.current = width;
      setWidth(suggestedWidth);
      setPanelWidth(storageKey, suggestedWidth);
      return;
    }
    if (widenedFrom.current !== null && widenedFrom.current >= 0) {
      setWidth(widenedFrom.current);
      setPanelWidth(storageKey, widenedFrom.current);
    }
    widenedFrom.current = null;
  }, [embedded, storageKey, suggestedWidth, width]);

  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {(header || actions) && (
        <header
          className={cn(
            "flex h-10 shrink-0 items-center justify-between gap-2 border-b pr-2",
            flushHeader ? "pl-1" : "pl-3"
          )}
        >
          {header}
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
        )}
        {children}
      </div>
    );
  }

  // The panel follows the pointer; the pane beside it does not. Resizing both
  // live re-laid the whole window out on every frame — the chat column is
  // centred, so it shifts with each pixel — and on a translucent window that
  // is a full-window recomposite per frame, which pinned WindowServer and
  // stuttered the whole machine. So the neighbour is held at its starting
  // width: the panel slides over it when it grows, and when it shrinks the
  // strip it uncovers is painted in the neighbour's own colour. The neighbour
  // lays out once, on release.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const aside = asideRef.current;
    const sibling = aside?.previousElementSibling;
    const beside = sibling instanceof HTMLElement ? sibling : null;
    const fill = beside ? edgeColor(beside) : "transparent";
    let latest = startW;
    let frame = 0;

    if (beside) {
      beside.style.width = `${beside.getBoundingClientRect().width}px`;
      beside.style.flex = "none";
    }
    // The handle trails the pointer by a frame, so the cursor and the
    // no-select have to hold for the whole document.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const paint = () => {
      frame = 0;
      if (!aside) return;
      aside.style.width = `${latest}px`;
      // The margin keeps the row's total constant: negative lets the panel
      // overlap the held pane, positive is the strip the shadow fills.
      if (beside) beside.style.marginRight = `${startW - latest}px`;
      aside.style.boxShadow =
        latest < startW ? `${latest - startW}px 0 0 0 ${fill}` : "";
    };
    const onMove = (ev: MouseEvent) => {
      const max = Math.round(window.innerWidth * 0.75);
      latest = Math.min(max, Math.max(PANEL_MIN_WIDTH, startW + startX - ev.clientX));
      // Coalesce many mousemove events into one style write per frame.
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame) cancelAnimationFrame(frame);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (aside) aside.style.boxShadow = "";
      if (beside) {
        beside.style.width = "";
        beside.style.flex = "";
        beside.style.marginRight = "";
      }
      setWidth(latest); // sync React state to the imperatively-driven width
      setPanelWidth(storageKey, latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside
      ref={asideRef}
      style={{ width }}
      className={cn(
        "relative flex shrink-0 flex-col border-l bg-card",
        "animate-in fade-in slide-in-from-right-2 duration-200 ease-out",
        !open && "hidden"
      )}
    >
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/30"
      />
      <header
        className={cn(
          "flex h-10 shrink-0 items-center justify-between gap-2 border-b pr-2",
          flushHeader ? "pl-1" : "pl-3"
        )}
      >
        {header}
        <div className="flex items-center gap-1">
          {actions}
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>
      {children}
    </aside>
  );
}
