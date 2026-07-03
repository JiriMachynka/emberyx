import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Settings } from "@/lib/settings";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}

function Field({
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

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onUpdate,
}: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Applies to terminals you open next; font changes apply live.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field label="Agent command" hint="Run on project open, e.g. claude or codex">
            <Input
              value={settings.agentCommand}
              onChange={(e) => onUpdate({ agentCommand: e.target.value })}
              spellCheck={false}
            />
          </Field>

          <Field label="Terminal font family">
            <Input
              value={settings.fontFamily}
              onChange={(e) => onUpdate({ fontFamily: e.target.value })}
              spellCheck={false}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Font size">
              <Input
                type="number"
                min={8}
                max={32}
                value={settings.fontSize}
                onChange={(e) =>
                  onUpdate({ fontSize: Number(e.target.value) || 13 })
                }
              />
            </Field>

            <Field label="Scrollback">
              <Input
                type="number"
                min={100}
                max={100000}
                step={100}
                value={settings.scrollback}
                onChange={(e) =>
                  onUpdate({ scrollback: Number(e.target.value) || 1000 })
                }
              />
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
