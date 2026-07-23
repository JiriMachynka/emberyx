import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { getVersion } from "@tauri-apps/api/app";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { checkForUpdates } from "@/lib/update";
import { useOpenRouterModels } from "@/lib/queries";
import type { Settings } from "@/lib/settings";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}

type Tab = "general" | "terminal" | "integrations";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Appearance" },
  { id: "integrations", label: "Integrations" },
];

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

function Toggle({
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

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onUpdate,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const isClaude = settings.agentCommand.startsWith("claude");
  const models = useOpenRouterModels(open).data ?? [];

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  async function onCheckUpdates() {
    setChecking(true);
    try {
      await checkForUpdates({ silent: false });
    } finally {
      setChecking(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Applies to terminals you open next; font changes apply live.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px border-b-2 px-2.5 py-1.5 text-sm font-medium transition-colors",
                tab === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="grid min-h-80 content-start gap-4">
          {tab === "general" && (
            <>
              <Field
                label="Agent interface"
                hint="Chat shows a rich message UI; Terminal runs the raw Claude Code TUI."
              >
                <select
                  value={settings.agentUi}
                  onChange={(e) =>
                    onUpdate({
                      agentUi: e.target.value as "chat" | "terminal",
                    })
                  }
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="chat">Chat UI</option>
                  <option value="terminal">Terminal</option>
                </select>
              </Field>

              <Field
                label="Agent command"
                hint="Run on project open, e.g. claude or codex"
              >
                <Input
                  value={settings.agentCommand}
                  onChange={(e) => onUpdate({ agentCommand: e.target.value })}
                  spellCheck={false}
                />
              </Field>

              {isClaude && (
                <Toggle
                  checked={settings.dangerouslySkipPermissions}
                  onChange={(v) => onUpdate({ dangerouslySkipPermissions: v })}
                  title="Skip permission prompts"
                >
                  Launch Claude with{" "}
                  <code className="text-[11px]">
                    --dangerously-skip-permissions
                  </code>
                  . The agent won't ask before running commands or edits.
                </Toggle>
              )}

              {isClaude && (
                <Toggle
                  checked={settings.resumeLatestThread}
                  onChange={(v) => onUpdate({ resumeLatestThread: v })}
                  title="Resume latest thread on open"
                >
                  Opening a project reopens the most recently worked-on thread.
                  Off launches a brand-new agent each time.
                </Toggle>
              )}

              {isClaude && (
                <Toggle
                  checked={settings.compactSession}
                  onChange={(v) => onUpdate({ compactSession: v })}
                  title="Compact session"
                >
                  Keep tool output collapsed. Off (default) runs a full session
                  with <code className="text-[11px]">--verbose</code>, expanding
                  tool output inline.
                </Toggle>
              )}

              <div className="flex items-center justify-between border-t pt-4">
                <div className="text-sm">
                  <div className="font-medium">Updates</div>
                  <div className="text-xs text-muted-foreground">
                    {version ? `Emberyx v${version}` : "Emberyx"}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checking}
                >
                  {checking ? "Checking…" : "Check for updates"}
                </Button>
              </div>
            </>
          )}

          {tab === "terminal" && (
            <>
              <Field label="Font family">
                <Input
                  value={settings.fontFamily}
                  onChange={(e) => onUpdate({ fontFamily: e.target.value })}
                  spellCheck={false}
                />
              </Field>

              <div className="grid grid-cols-3 gap-4">
                <Field label="Terminal font">
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

                <Field label="Editor font">
                  <Input
                    type="number"
                    min={8}
                    max={32}
                    value={settings.editorFontSize}
                    onChange={(e) =>
                      onUpdate({ editorFontSize: Number(e.target.value) || 13 })
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
            </>
          )}

          {tab === "integrations" && (
            <>
              <div>
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
                      onChange={(e) =>
                        onUpdate({ dokployApiKey: e.target.value })
                      }
                      spellCheck={false}
                    />
                  </Field>
                </div>
              </div>

              <div className="border-t pt-4">
                <div className="mb-3 text-sm font-semibold">OpenRouter</div>
                <div className="grid gap-4">
                  <Field
                    label="API key"
                    hint="Enables the Generate button on the commit box to draft messages from your diff."
                  >
                    <Input
                      type="password"
                      value={settings.openRouterApiKey}
                      onChange={(e) =>
                        onUpdate({ openRouterApiKey: e.target.value })
                      }
                      placeholder="sk-or-…"
                      spellCheck={false}
                    />
                  </Field>
                  <Field
                    label="Model"
                    hint="OpenRouter model slug. Defaults to google/gemini-3.5-flash."
                  >
                    <Input
                      list="openrouter-models"
                      value={settings.openRouterModel}
                      onChange={(e) =>
                        onUpdate({ openRouterModel: e.target.value })
                      }
                      placeholder="google/gemini-3.5-flash"
                      spellCheck={false}
                    />
                    <datalist id="openrouter-models">
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </datalist>
                  </Field>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
