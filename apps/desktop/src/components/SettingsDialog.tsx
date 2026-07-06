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

          {settings.agentCommand.startsWith("claude") && (
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={settings.dangerouslySkipPermissions}
                onChange={(e) =>
                  onUpdate({ dangerouslySkipPermissions: e.target.checked })
                }
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">
                  Skip permission prompts
                </span>
                <span className="text-xs text-muted-foreground">
                  Launch Claude with{" "}
                  <code className="text-[11px]">
                    --dangerously-skip-permissions
                  </code>
                  . The agent won't ask before running commands or edits.
                </span>
              </span>
            </label>
          )}

          {settings.agentCommand.startsWith("claude") && (
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={settings.resumeLatestThread}
                onChange={(e) =>
                  onUpdate({ resumeLatestThread: e.target.checked })
                }
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">
                  Resume latest thread on open
                </span>
                <span className="text-xs text-muted-foreground">
                  Opening a project reopens the most recently worked-on thread.
                  Off launches a brand-new agent each time.
                </span>
              </span>
            </label>
          )}

          {settings.agentCommand.startsWith("claude") && (
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={settings.compactSession}
                onChange={(e) =>
                  onUpdate({ compactSession: e.target.checked })
                }
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Compact session</span>
                <span className="text-xs text-muted-foreground">
                  Keep tool output collapsed. Off (default) runs a full session
                  with <code className="text-[11px]">--verbose</code>, expanding
                  tool output inline.
                </span>
              </span>
            </label>
          )}

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

          <div className="border-t pt-4">
            <div className="mb-3 text-sm font-semibold">Dokploy</div>
            <div className="grid gap-4">
              <Field
                label="Server URL"
                hint="Projects are matched to Dokploy services by git remote."
              >
                <Input
                  value={settings.dokployUrl}
                  onChange={(e) => onUpdate({ dokployUrl: e.target.value })}
                  placeholder="https://dokploy.example.com"
                  spellCheck={false}
                />
              </Field>
              <Field label="API key" hint="Sent as the x-api-key header.">
                <Input
                  type="password"
                  value={settings.dokployApiKey}
                  onChange={(e) => onUpdate({ dokployApiKey: e.target.value })}
                  spellCheck={false}
                />
              </Field>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
