import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Faces offered for the chat, composer and thread list. Sans first: the
 *  conversation is prose, not a terminal grid, but a monospace chat is a real
 *  preference so the mono stacks stay on the list. */
export const INTERFACE_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "DM Sans", value: '"DM Sans Variable", ui-sans-serif, system-ui, sans-serif' },
  { label: "Geist", value: '"Geist Variable", ui-sans-serif, system-ui, sans-serif' },
  { label: "System sans", value: "ui-sans-serif, system-ui, sans-serif" },
  { label: "Geist Mono", value: '"Geist Mono Variable", ui-monospace, Menlo, monospace' },
  {
    label: "JetBrains Mono",
    value:
      '"JetBrains Mono Variable", "Geist Mono Variable", ui-monospace, Menlo, monospace',
  },
];

/** Popular monospace families. Values are full font stacks; the first two match
 *  the shipped defaults so the current setting selects cleanly. */
const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Geist Mono", value: '"Geist Mono Variable", ui-monospace, Menlo, monospace' },
  {
    label: "JetBrains Mono",
    value:
      '"JetBrains Mono Variable", "Geist Mono Variable", ui-monospace, Menlo, monospace',
  },
  { label: "SF Mono", value: '"SF Mono", ui-monospace, Menlo, monospace' },
  { label: "Menlo", value: "Menlo, ui-monospace, monospace" },
  { label: "Monaco", value: "Monaco, ui-monospace, monospace" },
  { label: "Fira Code", value: '"Fira Code", ui-monospace, monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", ui-monospace, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", ui-monospace, monospace' },
  { label: "System monospace", value: "ui-monospace, monospace" },
];

/** Font-family picker: each option previews in its own family. An unrecognised
 *  stored stack shows up as a "Custom" entry so it still round-trips. */
export function FontSelect({
  value,
  onChange,
  options: catalog = FONT_OPTIONS,
}: {
  value: string;
  onChange: (value: string) => void;
  options?: { label: string; value: string }[];
}) {
  const known = catalog.some((f) => f.value === value);
  const options = known ? catalog : [{ label: "Custom", value }, ...catalog];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((f) => (
          <SelectItem
            key={f.value}
            value={f.value}
            preview={
              <span
                style={{
                  fontFamily: f.value,
                  fontFeatureSettings: '"liga" 1, "calt" 1',
                }}
              >
                AaBbCc 0123 {"=> {}"}
              </span>
            }
          >
            <span style={{ fontFamily: f.value }}>{f.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
