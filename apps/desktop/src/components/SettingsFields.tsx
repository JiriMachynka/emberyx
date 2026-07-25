/** Shared label/checkbox primitives for settings surfaces (global dialog and
 *  the per-project settings pane). Not shadcn — these live outside ui/. */
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

export function Toggle({
  checked,
  onChange,
  title,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}
