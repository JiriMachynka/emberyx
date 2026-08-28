import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { DOCK_LABEL, PICKER_OFFERS, type DockKind } from "@/lib/dock";
import { DOCK_ICONS } from "@/lib/dockIcons";

interface DockPickerProps {
  onPick: (kind: DockKind) => void;
  /** Override a card's title (e.g. "Pull request" vs "Merge request"). */
  titles?: Partial<Record<DockKind, string>>;
  /** Kind → why it can't be opened. The card stays visible, greyed out. */
  unavailable?: Partial<Record<DockKind, string>>;
}

/**
 * Empty dock: pick a surface instead of guessing. Letter keys match
 * the badges, and only fire while this chooser is mounted and the user isn't
 * typing in the composer.
 */
export function DockPicker({ onPick, titles, unavailable }: DockPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toUpperCase();
      const offer = PICKER_OFFERS.find((o) => o.shortcut === key);
      if (!offer || unavailable?.[offer.kind]) return;
      e.preventDefault();
      onPick(offer.kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPick, unavailable]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8 outline-none"
    >
      <h2 className="text-base font-semibold tracking-tight">Open a surface</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose what to show in the right panel.
      </p>
      <div className="mt-8 grid w-full max-w-lg grid-cols-2 gap-3">
        {PICKER_OFFERS.map((offer) => {
          const Icon = DOCK_ICONS[offer.kind];
          const blocked = unavailable?.[offer.kind];
          return (
            <button
              key={offer.kind}
              type="button"
              disabled={Boolean(blocked)}
              onClick={() => onPick(offer.kind)}
              className={cn(
                "relative rounded-xl border bg-secondary/40 p-4 text-left transition-colors",
                blocked
                  ? "cursor-not-allowed opacity-40"
                  : "hover:bg-secondary hover:text-foreground"
              )}
            >
              <kbd className="absolute right-3 top-3 grid size-6 place-items-center rounded-md border text-xs text-muted-foreground">
                {offer.shortcut}
              </kbd>
              <span className="flex items-center gap-2 pr-8 text-sm font-medium">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {titles?.[offer.kind] ?? DOCK_LABEL[offer.kind]}
              </span>
              <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
                {blocked ?? offer.blurb}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
