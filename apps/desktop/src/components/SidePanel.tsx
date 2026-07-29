import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPanelWidth, setPanelWidth, PANEL_MIN_WIDTH } from "@/lib/panels";

interface SidePanelProps {
  /** Distinct key per panel — its width is remembered under this name. */
  storageKey: string;
  /** Header's left slot: a title, or tab buttons. */
  header: React.ReactNode;
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
  children: React.ReactNode;
}

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
  children,
}: SidePanelProps) {
  const [width, setWidth] = useState(() => getPanelWidth(storageKey));

  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header
          className={cn(
            "flex h-11 shrink-0 items-center justify-between gap-2 border-b pr-2",
            flushHeader ? "pl-1" : "pl-3"
          )}
        >
          {header}
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
        {children}
      </div>
    );
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      const max = Math.round(window.innerWidth * 0.75);
      latest = Math.min(max, Math.max(PANEL_MIN_WIDTH, startW + startX - ev.clientX));
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPanelWidth(storageKey, latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside
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
          "flex h-11 shrink-0 items-center justify-between gap-2 border-b pr-2",
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
