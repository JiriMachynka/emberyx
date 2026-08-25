import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** Shared label/control primitives for settings surfaces (the full-page
 *  settings view and the per-project pane). Not shadcn — these live outside ui/. */
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
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A settings row on the full-width page: the name and its explanation read as
 *  one column on the left, the control sits flush right. Wide enough that the
 *  two never collide, so the control column keeps a fixed width rather than
 *  shrinking to whatever the label left over. */
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
    <div className="grid gap-2 py-1">
      <div className="flex items-start justify-between gap-8">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {hint}
            </span>
          )}
        </div>
        <div
          className={cn(
            "flex shrink-0 justify-end pt-0.5",
            wide ? "w-80" : "w-44"
          )}
        >
          {control}
        </div>
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
    <label className="grid cursor-pointer gap-2 py-1">
      <div className="flex items-start justify-between gap-8">
        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint && (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {hint}
            </span>
          )}
        </div>
        <div className="flex w-44 shrink-0 justify-end pt-0.5">
          <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={onChange}
          />
        </div>
      </div>
    </label>
  );
}

/** A titled group of rows. Groups are separated by a hairline rather than by
 *  whitespace alone, so a long tab still reads as sections. */
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
    <section className="grid gap-5 border-t pt-8 first-of-type:border-0 first-of-type:pt-0">
      {title && (
        <div className="grid gap-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
