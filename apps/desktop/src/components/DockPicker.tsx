import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DOCK_LABEL, PICKER_OFFERS, type DockKind } from "@/lib/dock";
import { DOCK_ICONS } from "@/lib/dockIcons";

interface DockPickerProps {
  onPick: (kind: DockKind) => void;
  /** Override a button's title (e.g. "Pull request" vs "Merge request"). */
  titles?: Partial<Record<DockKind, string>>;
  /** Kind → why it can't be opened. The button stays visible, greyed out. */
  unavailable?: Partial<Record<DockKind, string>>;
  /** Surfaces this dock may offer. Defaults to the full chooser list. */
  offers?: readonly { kind: DockKind; shortcut: string; blurb: string }[];
}

/**
 * Empty dock: pick a surface instead of guessing. Lives in the dock header as
 * chrome buttons. Letter keys match the badges, and only fire while this
 * chooser is mounted and the user isn't typing in the composer.
 */
export function DockPicker({
  onPick,
  titles,
  unavailable,
  offers = PICKER_OFFERS,
}: DockPickerProps) {
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
      const offer = offers.find((o) => o.shortcut === key);
      if (!offer || unavailable?.[offer.kind]) return;
      e.preventDefault();
      onPick(offer.kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPick, unavailable, offers]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto outline-none"
    >
      {offers.map((offer) => {
        const Icon = DOCK_ICONS[offer.kind];
        const blocked = unavailable?.[offer.kind];
        return (
          <Button
            key={offer.kind}
            type="button"
            variant="chrome"
            size="sm"
            disabled={Boolean(blocked)}
            title={blocked ?? offer.blurb}
            onClick={() => onPick(offer.kind)}
            className="shrink-0"
          >
            <Icon className="size-3.5" />
            {titles?.[offer.kind] ?? DOCK_LABEL[offer.kind]}
            <kbd className="rounded bg-background/60 px-1 text-3xs tabular-nums text-muted-foreground">
              {offer.shortcut}
            </kbd>
          </Button>
        );
      })}
    </div>
  );
}
