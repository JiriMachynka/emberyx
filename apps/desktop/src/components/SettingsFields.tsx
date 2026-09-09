import { ChevronDown } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Shared label/control primitives for settings surfaces (the full-page settings
 * view and the per-project pane). Not shadcn — these live outside ui/.
 *
 * The surface reads as a spec plate rather than a stack of cards: prose on the
 * left, state on the right, hairlines only under a group heading. A card is one
 * solid `--card` fill with a hairline border; the active one keeps the app's
 * inset ember ring, which is the only thing that should read as state. Mono is
 * reserved for what is genuinely machine text (a path, a binary, a chord); a
 * select full of prose is prose.
 */

/** The control column: fixed, so it never shrinks to whatever the label left
 *  over, and mono, because what sits in it is a value. */
function Control({
  wide,
  className,
  children,
}: {
  wide?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 justify-end pt-0.5 text-sm",
        wide ? "w-80" : "w-72",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="grid text-sm">{children}</span>
      {hint && (
        <span className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}

/** A settings row on the full-width page: the name and its explanation read as
 *  one column on the left, the value sits flush right. */
export function Row({
  label,
  hint,
  control,
  wide,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Rendered in the right-hand column. */
  control: React.ReactNode;
  /** Widen the control column — free text needs more room than a menu. */
  wide?: boolean;
  /** Extra full-width content below the row — a list, a note, a nested block. */
  children?: React.ReactNode;
}) {
  return (
    <div className="-mx-3 grid gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary/40">
      <div className="flex items-start justify-between gap-8">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {hint}
            </span>
          )}
        </div>
        <Control wide={wide}>{control}</Control>
      </div>
      {children}
    </div>
  );
}

/** A Row whose control is a switch. The whole row is the label, so the text is
 *  a hit target too. */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="-mx-3 grid cursor-pointer gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-secondary/40">
      <div className="flex items-start justify-between gap-8">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {hint}
            </span>
          )}
        </div>
        <Control>
          <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={onChange}
          />
        </Control>
      </div>
    </label>
  );
}

/** A titled group of rows. The heading is a spec rule — a mono micro-label with
 *  a hairline running to the right edge — rather than a card around the rows:
 *  space separates rows, a rule separates groups. */
export function Group({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3">
      {title && (
        <div className="grid gap-1">
          <h2 className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="shrink-0">{title}</span>
            <span aria-hidden className="h-px min-w-0 flex-1 bg-border/60" />
          </h2>
          {hint && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
      )}
      <div className="grid gap-1">{children}</div>
    </section>
  );
}

/** Where a thing stands, as one dot. Three states is all any settings tile has
 *  ever needed: working, needs attention, absent. */
export function StatusDot({
  tone,
  className,
}: {
  tone: "on" | "warn" | "off";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "on" && "bg-emerald-500",
        tone === "warn" && "bg-amber-500",
        tone === "off" && "bg-muted-foreground/40",
        className
      )}
    />
  );
}

/**
 * The one tile every settings list is built from — MCP servers, skills,
 * providers, source-control CLIs, the daemon.
 *
 * They were five near-copies that had drifted apart (different borders, some
 * raised and some flat, chevrons in two placements), which is what made a list
 * of them read as five different components on one page. One shell: identity on
 * the left, state on the right, and an optional disclosure body that shares the
 * tile's border rather than drawing its own.
 */
export function Tile({
  icon,
  status,
  title,
  meta,
  aside,
  expanded,
  onToggle,
  details,
  active,
}: {
  /** Provider mark or transport glyph, left of everything. */
  icon?: React.ReactNode;
  status?: "on" | "warn" | "off";
  title: React.ReactNode;
  /** The machine half — a binary name, a command, a description. */
  meta?: React.ReactNode;
  /** State on the right: chips, a version, an action. */
  aside?: React.ReactNode;
  expanded?: boolean;
  /** Present = the tile is a disclosure and grows a chevron. */
  onToggle?: () => void;
  details?: React.ReactNode;
  /** This tile is the current choice — the sidebar's treatment for an open
   *  thread, so a selected surface reads the same everywhere in the app. */
  active?: boolean;
}) {
  const head = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon}
        {status && <StatusDot tone={status} />}
        <span className="grid min-w-0 gap-0.5">
          <span className="flex items-center gap-2 truncate text-sm font-medium">
            {title}
          </span>
          {meta && (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              {meta}
            </span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {aside}
        {onToggle && (
          <ChevronDown
            className={cn(
              "size-4 transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
        )}
      </span>
    </>
  );

  return (
    <div
      className={cn(
        // One flat fill, not a translucent card over a gradient: a list of these
        // stacked read as a stack of slightly different greys.
        "overflow-hidden rounded-lg border bg-card transition-colors",
        active
          ? "border-primary/40 ring-1 ring-inset ring-primary/25"
          : "hover:border-foreground/15"
      )}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-4 px-3 py-2.5">
          {head}
        </div>
      )}
      {expanded && details && (
        <div className="grid gap-1.5 border-t bg-canvas/40 px-3 py-3 duration-150 animate-in fade-in-0 slide-in-from-top-1">
          {details}
        </div>
      )}
    </div>
  );
}
