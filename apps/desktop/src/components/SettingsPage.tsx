import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  Bell,
  Boxes,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Info,
  Keyboard,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Type,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { checkForUpdates } from "@/lib/update";
import {
  invalidateDaemon,
  invalidateForge,
  useDaemonHealth,
  useForgeToken,
  useOpenRouterModels,
  useProviderStatus,
} from "@/lib/queries";
import { IDES, IDE_LABEL, type IdeId } from "@/lib/ide";
import { PERMISSION_MODES, PERMISSION_MODE_LABEL } from "@/lib/settings";
import { PROVIDER_LABEL } from "@/lib/providers";
import { Field, Toggle } from "@/components/SettingsFields";
import {
  AGENT_BACKENDS,
  BACKEND_LABEL,
  capabilitiesOf,
  isAgentBackend,
} from "@/lib/agentBackend";
import type { LucideIcon } from "lucide-react";
import type { Settings } from "@/lib/settings";

interface SettingsPageProps {
  onBack: () => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}

type Tab =
  | "general"
  | "providers"
  | "permissions"
  | "connections"
  | "sourceControl"
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "about";

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", icon: Boxes },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "connections", label: "Connections", icon: Plug },
  { id: "sourceControl", label: "Source Control", icon: GitBranch },
  { id: "appearance", label: "Appearance", icon: Type },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

export function SettingsPage({
  onBack,
  settings,
  onUpdate,
}: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const capabilities = capabilitiesOf(settings.agentBackend);
  const models = useOpenRouterModels(true).data ?? [];
  const qc = useQueryClient();
  const hasGitlabToken = useForgeToken("gitlab").data ?? false;
  const hasGithubToken = useForgeToken("github").data ?? false;
  const [githubToken, setGithubToken] = useState("");
  const providers = useProviderStatus().data ?? [];
  const daemon = useDaemonHealth(true).data ?? null;
  const [startingDaemon, setStartingDaemon] = useState(false);
  // Held only until Save hands it to the keychain, then wiped.
  const [gitlabToken, setGitlabToken] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  async function onSaveGitlabToken() {
    await invoke("gitlab_set_token", { token: gitlabToken.trim() });
    setGitlabToken("");
    invalidateForge(qc);
  }

  async function onClearGitlabToken() {
    await invoke("gitlab_clear_token");
    invalidateForge(qc);
  }

  async function onSaveGithubToken() {
    await invoke("github_set_token", { token: githubToken.trim() });
    setGithubToken("");
    invalidateForge(qc);
  }

  async function onClearGithubToken() {
    await invoke("github_clear_token");
    invalidateForge(qc);
  }

  async function onStartDaemon() {
    setStartingDaemon(true);
    try {
      await invoke("daemon_start");
      invalidateDaemon(qc);
    } finally {
      setStartingDaemon(false);
    }
  }

  async function onCheckUpdates() {
    setChecking(true);
    try {
      await checkForUpdates({ silent: false });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="absolute inset-0 z-40 flex min-h-0 flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center border-b px-6">
        <button
          type="button"
          onClick={onBack}
          className="mr-4 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-95"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="text-xs text-muted-foreground">
            Applies to every project
          </p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-8 px-6 py-8 lg:px-12">
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r pr-4">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  tab === t.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                )}
              >
                <t.icon className="size-4 shrink-0" />
                {t.label}
              </button>
            ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid max-w-2xl content-start gap-4 pb-10">
              {tab === "general" && (
                <>
                  <Field
                    label="Agent interface"
                    hint="Chat shows a rich message UI; Terminal runs the raw Claude Code TUI."
                  >
                    <Select
                      value={settings.agentUi}
                      onValueChange={(v) =>
                        onUpdate({ agentUi: v as "chat" | "terminal" })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="chat">Chat UI</SelectItem>
                        <SelectItem value="terminal">Terminal</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  <Toggle
                    checked={settings.expandAllProjects}
                    onChange={(v) => onUpdate({ expandAllProjects: v })}
                    title="Expand every project"
                  >
                    When on, the sidebar keeps each project's own sessions
                    listed, not just the active project's.
                  </Toggle>

                  <Toggle
                    checked={settings.autoOpenDevPanel}
                    onChange={(v) => onUpdate({ autoOpenDevPanel: v })}
                    title="Auto-open dev panel on run"
                  >
                    Reveal the dev output panel whenever a dev, build, or start
                    run begins.
                  </Toggle>
                </>
              )}

              {tab === "providers" && (
                <>
                  <div>
                    <div className="mb-1 text-sm font-semibold">Installed</div>
                    <p className="mb-3 text-xs text-muted-foreground">
                      Detected by running each CLI's own version probe. A
                      provider that isn't installed is listed, not hidden — the
                      absence is the useful part.
                    </p>
                    <div className="grid gap-1.5">
                      {providers.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <img
                              src={`/provider-icons/${p.id}.svg`}
                              alt=""
                              className="size-5 shrink-0 object-contain"
                            />
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                p.installed ? "bg-emerald-500" : "bg-muted-foreground/40"
                              )}
                            />
                            <span className="truncate">
                              {PROVIDER_LABEL[p.id] ?? p.label}
                            </span>
                            <code className="shrink-0 text-[11px] text-muted-foreground">
                              {p.binary}
                            </code>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {p.installed ? p.version ?? "installed" : "not installed"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-t pt-4 grid gap-4">
                    <Field
                      label="Default backend"
                      hint="Which CLI the command drives. Projects can pin their own in the project's Settings tab."
                    >
                      <Select
                        value={settings.agentBackend}
                        onValueChange={(v) => {
                          if (isAgentBackend(v)) onUpdate({ agentBackend: v });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AGENT_BACKENDS.map((b) => (
                            <SelectItem key={b} value={b}>
                              {BACKEND_LABEL[b]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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

                    {capabilities.threads && (
                      <Toggle
                        checked={settings.resumeLatestThread}
                        onChange={(v) => onUpdate({ resumeLatestThread: v })}
                        title="Resume latest thread on open"
                      >
                        Opening a project reopens the most recently worked-on
                        thread. Off launches a brand-new agent each time.
                      </Toggle>
                    )}

                    {/* --verbose is Claude's own flag; buildAgentCommand emits
                        it for no one else. */}
                    {settings.agentBackend === "claude" && (
                      <Toggle
                        checked={settings.compactSession}
                        onChange={(v) => onUpdate({ compactSession: v })}
                        title="Compact session"
                      >
                        Keep tool output collapsed. Off (default) runs a full
                        session with <code className="text-[11px]">--verbose</code>
                        , expanding tool output inline.
                      </Toggle>
                    )}
                  </div>
                </>
              )}

              {tab === "permissions" && (
                <>
                  {capabilities.permissions ? (
                    <>
                      <Field
                        label="Permission mode"
                        hint="How Claude handles a tool it hasn't been allowed yet."
                      >
                        <Select
                          value={settings.permissionMode}
                          disabled={settings.dangerouslySkipPermissions}
                          onValueChange={(v) =>
                            onUpdate({ permissionMode: v as typeof settings.permissionMode })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PERMISSION_MODES.map((m) => (
                              <SelectItem key={m} value={m}>
                                {PERMISSION_MODE_LABEL[m]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>

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
                        This replaces the mode above rather than refining it —
                        the two flags are mutually exclusive.
                      </Toggle>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {BACKEND_LABEL[settings.agentBackend]} manages approvals
                      itself; there is nothing here to set.
                    </p>
                  )}
                </>
              )}

              {tab === "shortcuts" && (
                <div className="grid gap-1">
                  {SHORTCUTS.map((s) => (
                    <div
                      key={s.keys}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm odd:bg-secondary/30"
                    >
                      <span className="text-muted-foreground">{s.action}</span>
                      <kbd className="rounded border bg-background px-1.5 py-0.5 text-xs">
                        {s.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              )}

              {tab === "notifications" && (
                <>
                  <Toggle
                    checked={settings.notifyOnDone}
                    onChange={(v) => onUpdate({ notifyOnDone: v })}
                    title="Notify when a task finishes"
                  >
                    Raise a notification once a run completes.
                  </Toggle>

                  <Toggle
                    checked={settings.notifyOnError}
                    onChange={(v) => onUpdate({ notifyOnError: v })}
                    title="Notify on errors"
                  >
                    Raise a notification when a run fails.
                  </Toggle>

                  <Toggle
                    checked={settings.notifyOnAccountIssue}
                    onChange={(v) => onUpdate({ notifyOnAccountIssue: v })}
                    title="Notify on account issues"
                  >
                    Raise a notification when the usage limit is hit or the login
                    expires.
                  </Toggle>

                  <Toggle
                    checked={settings.notifyOnlyWhenUnfocused}
                    onChange={(v) => onUpdate({ notifyOnlyWhenUnfocused: v })}
                    title="Only when app is unfocused"
                  >
                    Stay quiet while Emberyx is the focused window.
                  </Toggle>

                  <Toggle
                    checked={settings.notifySound}
                    onChange={(v) => onUpdate({ notifySound: v })}
                    title="Play sound"
                  >
                    Play a chime alongside each notification.
                  </Toggle>
                </>
              )}

              {tab === "appearance" && (
                <>
                  <div>
                    <div className="mb-3 text-sm font-semibold">Interface</div>
                    <div className="grid gap-4">
                      <Field
                        label="Font family"
                        hint="Used by the chat and terminal panes."
                      >
                        <FontSelect
                          value={settings.fontFamily}
                          onChange={(v) => onUpdate({ fontFamily: v })}
                        />
                      </Field>
                      <div className="grid grid-cols-2 gap-4">
                        <Field label="Font size">
                          <NumberStepper
                            value={settings.fontSize}
                            min={8}
                            max={32}
                            onChange={(n) => onUpdate({ fontSize: n })}
                          />
                        </Field>
                        <Field label="Scrollback">
                          <NumberStepper
                            value={settings.scrollback}
                            min={100}
                            max={100000}
                            step={100}
                            onChange={(n) => onUpdate({ scrollback: n })}
                          />
                        </Field>
                      </div>
                    </div>
                  </div>

                  <div className="border-t pt-4">
                    <div className="mb-3 text-sm font-semibold">Editor</div>
                    <div className="grid gap-4">
                      <Field
                        label="Font family"
                        hint="Used by the code editor."
                      >
                        <FontSelect
                          value={settings.editorFontFamily}
                          onChange={(v) => onUpdate({ editorFontFamily: v })}
                        />
                      </Field>
                      <div className="grid grid-cols-2 gap-4">
                        <Field label="Font size">
                          <NumberStepper
                            value={settings.editorFontSize}
                            min={8}
                            max={32}
                            onChange={(n) => onUpdate({ editorFontSize: n })}
                          />
                        </Field>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {tab === "connections" && (
                <>
                  <div>
                    <div className="mb-1 text-sm font-semibold">
                      Persistent agents
                    </div>
                    <p className="mb-3 text-xs text-muted-foreground">
                      With <code className="text-[11px]">emberyxd</code> running,
                      chat agents live in the daemon and survive closing the
                      window. Without it, they stop when the window does.
                    </p>
                    <div className="mb-4 flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            daemon ? "bg-emerald-500" : "bg-muted-foreground/40"
                          )}
                        />
                        {daemon
                          ? `Running · v${daemon.version} · ${daemon.agentCount} agent${daemon.agentCount === 1 ? "" : "s"}`
                          : "Not running"}
                      </span>
                      {!daemon && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={onStartDaemon}
                          disabled={startingDaemon}
                        >
                          {startingDaemon ? "Starting…" : "Start"}
                        </Button>
                      )}
                    </div>
                    <Toggle
                      checked={settings.persistentAgents}
                      onChange={(v) => onUpdate({ persistentAgents: v })}
                      title="Keep agents running in the background"
                    >
                      New chats run inside the daemon. A resumed thread renders
                      from the daemon's own replay, so reopening an older
                      conversation starts empty and fills from the next turn.
                    </Toggle>
                  </div>

                  <div className="border-t pt-4">
                    <div className="mb-3 text-sm font-semibold">
                      External editor
                    </div>
                    <div className="grid gap-4">
                      <Field
                        label="Open in"
                        hint="Used by Run → Open in…, and needs the editor's command line tools on PATH."
                      >
                        <Select
                          value={settings.ide}
                          onValueChange={(v) => onUpdate({ ide: v as IdeId })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {IDES.map((ide) => (
                              <SelectItem key={ide.id} value={ide.id}>
                                {ide.label}
                              </SelectItem>
                            ))}
                            <SelectItem value="custom">
                              {IDE_LABEL.custom}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      {settings.ide === "custom" && (
                        <Field
                          label="Custom command"
                          hint="Placeholders: {project} {file} {line} {column}. Run directly, not through a shell — quote paths with spaces."
                        >
                          <Input
                            value={settings.ideCustomCommand}
                            onChange={(e) =>
                              onUpdate({ ideCustomCommand: e.target.value })
                            }
                            placeholder={'mate "{project}" -l {line} "{file}"'}
                            spellCheck={false}
                          />
                        </Field>
                      )}
                    </div>
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
                          onChange={(e) =>
                            onUpdate({ dokployUrl: e.target.value })
                          }
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

              {tab === "sourceControl" && (
                <>
                  <div>
                    <div className="mb-3 text-sm font-semibold">GitHub</div>
                    <div className="grid gap-4">
                      <Field
                        label="Personal access token"
                        hint="Needs the repo scope. github.com only. Stored in the OS keychain, never on disk."
                      >
                        {hasGithubToken ? (
                          <div className="flex items-center gap-2">
                            <span className="flex h-9 flex-1 items-center rounded-md border border-input px-3 text-sm text-muted-foreground">
                              •••••••• Connected
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={onClearGithubToken}
                            >
                              Disconnect
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Input
                              type="password"
                              value={githubToken}
                              onChange={(e) => setGithubToken(e.target.value)}
                              placeholder="ghp_… or github_pat_…"
                              spellCheck={false}
                              autoComplete="off"
                            />
                            <Button
                              size="sm"
                              onClick={onSaveGithubToken}
                              disabled={!githubToken.trim()}
                            >
                              Save
                            </Button>
                          </div>
                        )}
                      </Field>
                    </div>
                  </div>

                  <div className="border-t pt-4">
                    <div className="mb-3 text-sm font-semibold">GitLab</div>
                    <div className="grid gap-4">
                      <Field
                        label="Personal access token"
                        hint="Needs the read_api scope. gitlab.com only. Stored in the OS keychain, never on disk."
                      >
                        {hasGitlabToken ? (
                          <div className="flex items-center gap-2">
                            <span className="flex h-9 flex-1 items-center rounded-md border border-input px-3 text-sm text-muted-foreground">
                              •••••••• Connected
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={onClearGitlabToken}
                            >
                              Disconnect
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Input
                              type="password"
                              value={gitlabToken}
                              onChange={(e) => setGitlabToken(e.target.value)}
                              placeholder="glpat-…"
                              spellCheck={false}
                              autoComplete="off"
                            />
                            <Button
                              size="sm"
                              onClick={onSaveGitlabToken}
                              disabled={!gitlabToken.trim()}
                            >
                              Save
                            </Button>
                          </div>
                        )}
                      </Field>
                      <Field
                        label="Remote"
                        hint="Git remote used to fetch and check out MR branches."
                      >
                        <Input
                          value={settings.gitlabRemote}
                          onChange={(e) =>
                            onUpdate({ gitlabRemote: e.target.value })
                          }
                          placeholder="origin"
                          spellCheck={false}
                        />
                      </Field>
                    </div>
                  </div>

                </>
              )}

              {tab === "about" && (
                <div className="flex items-center justify-between">
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
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Popular monospace families. Values are full font stacks; the first two match
 *  the shipped defaults so the current setting selects cleanly. */
/** The shortcuts `useShortcuts` actually binds, plus the menu's own. Listed,
 *  not editable: nothing rebinds them yet, and a settings screen that pretends
 *  otherwise is worse than one that just tells you what the keys are. */
const SHORTCUTS: { action: string; keys: string }[] = [
  { action: "Command palette", keys: "⌘K" },
  { action: "New agent tab", keys: "⌘T" },
  { action: "Close tab", keys: "⌘W" },
  { action: "Toggle sidebar", keys: "⌘B" },
  { action: "Search in project", keys: "⇧⌘F" },
  { action: "Settings", keys: "⌘," },
  { action: "Send message", keys: "↵" },
  { action: "Newline in composer", keys: "⇧↵" },
];

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
function FontSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const known = FONT_OPTIONS.some((f) => f.value === value);
  const options = known ? FONT_OPTIONS : [{ label: "Custom", value }, ...FONT_OPTIONS];
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

/** Number field with visible custom steppers — the native spinner arrows are
 *  near-invisible on the dark surface. */
function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="relative">
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        className="pr-8 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 flex-col">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onChange(clamp(value + step))}
          className="flex h-3.5 items-center rounded-sm px-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronUp className="size-3.5" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onChange(clamp(value - step))}
          className="flex h-3.5 items-center rounded-sm px-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
