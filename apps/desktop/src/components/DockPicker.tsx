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
  offers?: readonly { kind: DockKind; blurb: string }[];
}

/** Quick access to the dock's surfaces, rendered in the top bar. */
export function DockPicker({
  onPick,
  titles,
  unavailable,
  offers = PICKER_OFFERS,
}: DockPickerProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
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
          </Button>
        );
      })}
    </div>
  );
}
