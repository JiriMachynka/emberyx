import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/themes";

/** A theme's own tokens, drawn as a miniature of the app: sidebar rail, chat
 *  canvas, composer, accent. Painted from the theme's values rather than the
 *  live variables, so an unselected card still shows what it would look like. */
export function ThemeCard({
  theme,
  selected,
  onSelect,
}: {
  theme: Theme;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = theme.tokens;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        // Same shell as every other settings tile; only the selected ring is
        // its own, because a theme card is a choice and the rest are state.
        "group rounded-lg border bg-card p-2 text-left transition-colors",
        selected
          ? "border-primary/40 ring-1 ring-inset ring-primary/25"
          : "hover:border-foreground/15"
      )}
    >
      <div
        className="flex h-20 gap-1 overflow-hidden rounded-md p-1"
        style={{ backgroundColor: t["--background"] }}
      >
        <div
          className="w-1/4 rounded-sm"
          style={{ backgroundColor: t["--sidebar"] }}
        />
        <div
          className="flex flex-1 flex-col justify-between rounded-sm p-1"
          style={{ backgroundColor: t["--chat-canvas"] }}
        >
          <div
            className="h-1.5 w-2/3 rounded-full"
            style={{ backgroundColor: t["--primary"] }}
          />
          <div
            className="h-5 rounded-sm"
            style={{
              backgroundColor: t["--composer"],
              boxShadow: `0 0 10px -4px ${t["--glow"]}`,
            }}
          />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 px-0.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: t["--primary"] }}
        />
        <span className="text-sm font-medium">{theme.label}</span>
      </div>
      <p className="mt-0.5 px-0.5 text-xs text-muted-foreground">{theme.hint}</p>
    </button>
  );
}
