import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
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
  RotateCcw,
  Search,
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
  useDaemonHealth,
  useForgeCliStatus,
  useOpenRouterModels,
  useProviderStatus,
} from "@/lib/queries";
import { IDES, IDE_LABEL, type IdeId } from "@/lib/ide";
import {
  DEFAULT_SETTINGS,
  PERMISSION_MODES,
  PERMISSION_MODE_LABEL,
} from "@/lib/settings";
import { PROVIDER_LABEL } from "@/lib/providers";
import { Group, Row, SwitchRow } from "@/components/SettingsFields";
import { COMMANDS, type CommandId } from "@/lib/commands";
import {
  chordFromEvent,
  conflictingBindings,
  displayChord,
  formatChord,
  resetAllBindings,
  resetBinding,
  resolveBindings,
  setBinding,
} from "@/lib/keybindings";
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
  | "appearance"
  | "shortcuts"
  | "providers"
  | "permissions"
  | "connections"
  | "sourceControl"
  | "notifications"
  | "about";

/** A tab owns the settings keys it edits, which is what "Restore defaults"
 *  resets, and the words that should find it from the search box — a setting
 *  you can name but can't place is the reason the box exists. */
interface TabMeta {
  id: Tab;
  label: string;
  icon: LucideIcon;
  keys: (keyof Settings)[];
  finds: string;
}

const TABS: TabMeta[] = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    keys: [
      "agentUi",
      "threadView",
      "threadGrouping",
      "threadSettleDays",
      "threadAutoSettleOnMerge",
      "expandAllProjects",
      "autoOpenDevPanel",
    ],
    finds: "agent interface chat terminal thread list sidebar settle merge group project dev panel",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Type,
    keys: [
      "chatFontFamily",
      "fontFamily",
      "editorFontFamily",
      "fontSize",
      "editorFontSize",
      "scrollback",
    ],
    finds: "font family size chat terminal editor scrollback theme typography",
  },
  {
    id: "shortcuts",
    label: "Keyboard Shortcuts",
    icon: Keyboard,
    keys: [],
    finds: "keys keybindings chords shortcuts rebind",
  },
  {
    id: "providers",
    label: "Providers",
    icon: Boxes,
    keys: ["agentBackend", "agentCommand", "resumeLatestThread", "compactSession"],
    finds: "claude codex backend cli command installed version resume compact",
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: ShieldCheck,
    keys: ["permissionMode", "dangerouslySkipPermissions"],
    finds: "tools approvals permission mode bypass accept edits dangerous",
  },
  {
    id: "connections",
    label: "Connections",
    icon: Plug,
    keys: [
      "persistentAgents",
      "ide",
      "ideCustomCommand",
      "dokployUrl",
      "dokployApiKey",
      "openRouterApiKey",
      "openRouterModel",
    ],
    finds: "daemon emberyxd persistent background editor ide vscode dokploy openrouter api key",
  },
  {
    id: "sourceControl",
    label: "Source Control",
    icon: GitBranch,
    keys: ["gitlabRemote"],
    finds: "git github gitlab gh glab cli login remote pull request merge request",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    keys: [
      "notifyOnDone",
      "notifyOnError",
      "notifyOnAccountIssue",
      "notifyOnlyWhenUnfocused",
      "notifySound",
    ],
    finds: "notify notification sound alert done error account unfocused",
  },
  { id: "about", label: "About", icon: Info, keys: [], finds: "version update release" },
];

const TAB_META = (id: Tab) => TABS.find((t) => t.id === id) as TabMeta;

/** The subset of DEFAULT_SETTINGS a tab owns, for its Restore defaults action. */
const defaultsFor = (keys: (keyof Settings)[]): Partial<Settings> =>
  Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]]));

export function SettingsPage({
  onBack,
  settings,
  onUpdate,
}: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const capabilities = capabilitiesOf(settings.agentBackend);
  const models = useOpenRouterModels(true).data ?? [];
  const qc = useQueryClient();
  const providers = useProviderStatus().data ?? [];
  const forgeClis = useForgeCliStatus().data ?? [];
  const daemon = useDaemonHealth(true).data ?? null;
  const [startingDaemon, setStartingDaemon] = useState(false);

  const meta = TAB_META(tab);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TABS;
    return TABS.filter((t) =>
      `${t.label} ${t.finds}`.toLowerCase().includes(q)
    );
  }, [query]);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // `/` jumps to the search box, unless something already has the keyboard.
  // Escape is Back — this is a page, not a dialog with a dimmed chat behind it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onBack();
        return;
      }
      if (e.key !== "/") return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  async function onRestoreDefaults() {
    const ok = await ask(
      `Reset every ${meta.label} setting to its default? Anything typed here — keys, URLs, commands — is replaced.`,
      { title: "Restore defaults", kind: "warning" }
    );
    if (ok) onUpdate(defaultsFor(meta.keys));
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
    <div className="flex min-h-0 min-w-0 flex-1 bg-background">
      <nav className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex h-14 shrink-0 items-center px-4 text-sm font-semibold tracking-tight">
          <span className="ember-text">Emberyx</span>
        </div>

        <div className="px-3 pb-2">
          <div className="flex h-9 items-center gap-2 rounded-lg bg-secondary px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="shrink-0 rounded border px-1.5 text-xs text-muted-foreground">
              /
            </kbd>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {matches.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                tab === t.id
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
            >
              <t.icon className="size-4 shrink-0" />
              {t.label}
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-2.5 py-6 text-xs text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-2.5 border-t px-5 py-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between px-6">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Settings</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-foreground">{meta.label}</span>
          </div>
          {meta.keys.length > 0 && (
            <button
              type="button"
              onClick={onRestoreDefaults}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="size-3.5" />
              Restore defaults
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-4xl content-start gap-8 px-6 pb-16 pt-4">
            <h1 className="text-xl font-semibold tracking-tight">{meta.label}</h1>

            {tab === "general" && (
              <Group>
                <Row
                  label="Agent interface"
                  hint="Chat shows a rich message UI; Terminal runs the raw agent TUI."
                  control={
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
                  }
                />

                <Row
                  label="Thread list"
                  hint="Whether the sidebar groups threads by project or shows one list across every open project."
                  control={
                    <Select
                      value={settings.threadView}
                      onValueChange={(value) => {
                        if (value === "project" || value === "all") {
                          onUpdate({ threadView: value });
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="project">By project</SelectItem>
                        <SelectItem value="all">All threads</SelectItem>
                      </SelectContent>
                    </Select>
                  }
                />

                {settings.threadView === "all" && (
                  <>
                    <Row
                      label="Group threads"
                      hint="Put one heading per repository above the active threads, with worktrees folded into their parent repo."
                      control={
                        <Select
                          value={settings.threadGrouping}
                          onValueChange={(value) => {
                            if (value === "none" || value === "repository") {
                              onUpdate({ threadGrouping: value });
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">One flat list</SelectItem>
                            <SelectItem value="repository">
                              By repository
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      }
                    />

                    <Row
                      label="Days of inactivity before a thread settles"
                      hint="Days a thread can go untouched before it folds into Settled. Set 0 to keep every thread listed until you settle it yourself."
                      control={
                        <NumberStepper
                          value={settings.threadSettleDays}
                          min={0}
                          max={90}
                          onChange={(n) => onUpdate({ threadSettleDays: n })}
                        />
                      }
                    />

                    <SwitchRow
                      label="Settle merged branches"
                      hint="Fold a thread away once its branch has been merged into the default branch, however recent the thread is."
                      checked={settings.threadAutoSettleOnMerge}
                      onChange={(v) => onUpdate({ threadAutoSettleOnMerge: v })}
                    />
                  </>
                )}

                <SwitchRow
                  label="Expand every project"
                  hint="Keep each project's own sessions listed in the sidebar, not just the active project's."
                  checked={settings.expandAllProjects}
                  onChange={(v) => onUpdate({ expandAllProjects: v })}
                />

                <SwitchRow
                  label="Auto-open dev panel on run"
                  hint="Reveal the dev output panel whenever a dev, build, or start run begins."
                  checked={settings.autoOpenDevPanel}
                  onChange={(v) => onUpdate({ autoOpenDevPanel: v })}
                />
              </Group>
            )}

            {tab === "appearance" && (
              <>
                <Group title="Interface">
                  <Row
                    label="Chat font"
                    hint="Used by the chat transcript, the composer and the thread list."
                    control={
                      <FontSelect
                        value={settings.chatFontFamily}
                        options={INTERFACE_FONT_OPTIONS}
                        onChange={(v) => onUpdate({ chatFontFamily: v })}
                      />
                    }
                  />
                  <Row
                    label="Terminal font"
                    hint="Used by the terminal, dev output and log panes."
                    control={
                      <FontSelect
                        value={settings.fontFamily}
                        onChange={(v) => onUpdate({ fontFamily: v })}
                      />
                    }
                  />
                  <Row
                    label="Font size"
                    hint="Terminal and chat text size, in pixels."
                    control={
                      <NumberStepper
                        value={settings.fontSize}
                        min={8}
                        max={32}
                        onChange={(n) => onUpdate({ fontSize: n })}
                      />
                    }
                  />
                  <Row
                    label="Scrollback"
                    hint="Lines of terminal history kept per session."
                    control={
                      <NumberStepper
                        value={settings.scrollback}
                        min={100}
                        max={100000}
                        step={100}
                        onChange={(n) => onUpdate({ scrollback: n })}
                      />
                    }
                  />
                </Group>

                <Group title="Editor">
                  <Row
                    label="Font family"
                    hint="Used by the built-in editor, chat code blocks and diffs."
                    control={
                      <FontSelect
                        value={settings.editorFontFamily}
                        onChange={(v) => onUpdate({ editorFontFamily: v })}
                      />
                    }
                  />
                  <Row
                    label="Font size"
                    hint="Editor text size, in pixels."
                    control={
                      <NumberStepper
                        value={settings.editorFontSize}
                        min={8}
                        max={32}
                        onChange={(n) => onUpdate({ editorFontSize: n })}
                      />
                    }
                  />
                </Group>
              </>
            )}

            {tab === "shortcuts" && <ShortcutsSection />}

            {tab === "providers" && (
              <>
                <Group
                  title="Installed"
                  hint="Detected from your login-shell PATH and each CLI's version probe. A provider that isn't installed is listed, not hidden — the absence is the useful part."
                >
                  <div className="grid gap-1.5">
                    {providers.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm"
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
                              p.installed
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/40"
                            )}
                          />
                          <span className="truncate">
                            {PROVIDER_LABEL[p.id] ?? p.label}
                          </span>
                          <code className="shrink-0 text-xs text-muted-foreground">
                            {p.binary}
                          </code>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {p.installed ? p.version ?? "installed" : "not installed"}
                        </span>
                      </div>
                    ))}
                  </div>
                </Group>

                <Group title="Defaults">
                  <Row
                    label="Default backend"
                    hint="Which CLI the command drives. Projects can pin their own in the project's Settings tab."
                    control={
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
                    }
                  />

                  <Row
                    label="Agent command"
                    hint="Run on project open, e.g. claude or codex."
                    control={
                      <Input
                        value={settings.agentCommand}
                        onChange={(e) => onUpdate({ agentCommand: e.target.value })}
                        spellCheck={false}
                      />
                    }
                  />

                  {capabilities.threads && (
                    <SwitchRow
                      label="Resume latest thread on open"
                      hint="Opening a project reopens the most recently worked-on thread. Off launches a brand-new agent each time."
                      checked={settings.resumeLatestThread}
                      onChange={(v) => onUpdate({ resumeLatestThread: v })}
                    />
                  )}

                  {/* --verbose is Claude's own flag; buildAgentCommand emits
                      it for no one else. */}
                  {settings.agentBackend === "claude" && (
                    <SwitchRow
                      label="Compact session"
                      hint="Keep tool output collapsed. Off runs a full session with --verbose, expanding tool output inline."
                      checked={settings.compactSession}
                      onChange={(v) => onUpdate({ compactSession: v })}
                    />
                  )}
                </Group>
              </>
            )}

            {tab === "permissions" && (
              <Group>
                {capabilities.permissions ? (
                  <>
                    <Row
                      label="Permission mode"
                      hint="How Claude handles a tool it hasn't been allowed yet."
                      control={
                        <Select
                          value={settings.permissionMode}
                          disabled={settings.dangerouslySkipPermissions}
                          onValueChange={(v) =>
                            onUpdate({
                              permissionMode: v as typeof settings.permissionMode,
                            })
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
                      }
                    />

                    <SwitchRow
                      label="Skip permission prompts"
                      hint="Launch Claude with --dangerously-skip-permissions. The agent won't ask before running commands or edits. This replaces the mode above rather than refining it — the two flags are mutually exclusive."
                      checked={settings.dangerouslySkipPermissions}
                      onChange={(v) =>
                        onUpdate({ dangerouslySkipPermissions: v })
                      }
                    />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {BACKEND_LABEL[settings.agentBackend]} manages approvals
                    itself; there is nothing here to set.
                  </p>
                )}
              </Group>
            )}

            {tab === "connections" && (
              <>
                <Group
                  title="Persistent agents"
                  hint="With emberyxd running, chat agents live in the daemon and survive closing the window. Without it, they stop when the window does."
                >
                  <div className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm">
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
                  <SwitchRow
                    label="Keep agents running in the background"
                    hint="New chats run inside the daemon. A resumed thread renders from the daemon's own replay, so reopening an older conversation starts empty and fills from the next turn."
                    checked={settings.persistentAgents}
                    onChange={(v) => onUpdate({ persistentAgents: v })}
                  />
                </Group>

                <Group title="External editor">
                  <Row
                    label="Open in"
                    hint="Used by Run → Open in…, and needs the editor's command line tools on PATH."
                    control={
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
                    }
                  />
                  {settings.ide === "custom" && (
                    <Row
                      wide
                      label="Custom command"
                      hint="Placeholders: {project} {file} {line} {column}. Run directly, not through a shell — quote paths with spaces."
                      control={
                        <Input
                          value={settings.ideCustomCommand}
                          onChange={(e) =>
                            onUpdate({ ideCustomCommand: e.target.value })
                          }
                          placeholder={'mate "{project}" -l {line} "{file}"'}
                          spellCheck={false}
                        />
                      }
                    />
                  )}
                </Group>

                <Group title="Dokploy">
                  <Row
                    wide
                    label="Server URL"
                    hint="Projects are matched to Dokploy services by git remote."
                    control={
                      <Input
                        value={settings.dokployUrl}
                        onChange={(e) => onUpdate({ dokployUrl: e.target.value })}
                        placeholder="https://dokploy.example.com"
                        spellCheck={false}
                      />
                    }
                  />
                  <Row
                    wide
                    label="API key"
                    hint="Sent as the x-api-key header."
                    control={
                      <Input
                        type="password"
                        value={settings.dokployApiKey}
                        onChange={(e) =>
                          onUpdate({ dokployApiKey: e.target.value })
                        }
                        spellCheck={false}
                      />
                    }
                  />
                </Group>

                <Group title="OpenRouter">
                  <Row
                    wide
                    label="API key"
                    hint="Enables the Generate button on the commit box to draft messages from your diff."
                    control={
                      <Input
                        type="password"
                        value={settings.openRouterApiKey}
                        onChange={(e) =>
                          onUpdate({ openRouterApiKey: e.target.value })
                        }
                        placeholder="sk-or-…"
                        spellCheck={false}
                      />
                    }
                  />
                  <Row
                    wide
                    label="Model"
                    hint="OpenRouter model slug. Defaults to google/gemini-3.5-flash."
                    control={
                      <>
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
                      </>
                    }
                  />
                </Group>
              </>
            )}

            {tab === "sourceControl" && (
              <>
                <Group
                  title="CLIs"
                  hint="Reviews use the GitHub (gh) and GitLab (glab) CLIs on your PATH. Log in with gh auth login or glab auth login — Emberyx never stores a PAT of its own."
                >
                  <div className="grid gap-1.5">
                    {forgeClis.map((p) => {
                      const status = !p.installed
                        ? "not installed"
                        : p.authenticated
                          ? (p.version ?? "logged in")
                          : "not logged in";
                      return (
                        <div
                          key={p.id}
                          className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <img
                              src={`/source-control-icons/${p.id}.svg`}
                              alt=""
                              className="size-5 shrink-0 object-contain"
                            />
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                p.authenticated
                                  ? "bg-emerald-500"
                                  : p.installed
                                    ? "bg-amber-500"
                                    : "bg-muted-foreground/40"
                              )}
                            />
                            <span className="truncate">{p.label}</span>
                            <code className="shrink-0 text-xs text-muted-foreground">
                              {p.binary}
                            </code>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {status}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Group>

                <Group title="Git">
                  <Row
                    label="Remote"
                    hint="Git remote used to fetch and check out review branches."
                    control={
                      <Input
                        value={settings.gitlabRemote}
                        onChange={(e) => onUpdate({ gitlabRemote: e.target.value })}
                        placeholder="origin"
                        spellCheck={false}
                      />
                    }
                  />
                </Group>
              </>
            )}

            {tab === "notifications" && (
              <Group>
                <SwitchRow
                  label="Notify when a task finishes"
                  hint="Raise a notification once a run completes."
                  checked={settings.notifyOnDone}
                  onChange={(v) => onUpdate({ notifyOnDone: v })}
                />
                <SwitchRow
                  label="Notify on errors"
                  hint="Raise a notification when a run fails."
                  checked={settings.notifyOnError}
                  onChange={(v) => onUpdate({ notifyOnError: v })}
                />
                <SwitchRow
                  label="Notify on account issues"
                  hint="Raise a notification when the usage limit is hit or the login expires."
                  checked={settings.notifyOnAccountIssue}
                  onChange={(v) => onUpdate({ notifyOnAccountIssue: v })}
                />
                <SwitchRow
                  label="Only when the app is unfocused"
                  hint="Stay quiet while Emberyx is the focused window."
                  checked={settings.notifyOnlyWhenUnfocused}
                  onChange={(v) => onUpdate({ notifyOnlyWhenUnfocused: v })}
                />
                <SwitchRow
                  label="Play sound"
                  hint="Play a chime alongside each notification."
                  checked={settings.notifySound}
                  onChange={(v) => onUpdate({ notifySound: v })}
                />
              </Group>
            )}

            {tab === "about" && (
              <Group>
                <Row
                  label="Updates"
                  hint={version ? `Emberyx v${version}` : "Emberyx"}
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCheckUpdates}
                      disabled={checking}
                    >
                      {checking ? "Checking…" : "Check for updates"}
                    </Button>
                  }
                />
              </Group>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Chords the composer owns. They aren't commands — nothing dispatches them —
 *  so they're listed for reference rather than offered for rebinding. */
const COMPOSER_KEYS: { action: string; keys: string }[] = [
  { action: "Send message", keys: "↵" },
  { action: "Newline in composer", keys: "⇧↵" },
];

/** Rebindable commands, plus the fixed ones, plus the composer's own keys.
 *  Recording a chord replaces the binding on the next keypress; Esc backs out. */
function ShortcutsSection() {
  const [bindings, setBindings] = useState(resolveBindings);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const clashing = conflictingBindings(bindings);

  const publish = (next: Record<CommandId, string>) => {
    setBindings(next);
    // Tell the live handler to re-read; a rebind that needs a restart to work
    // reads as broken.
    window.dispatchEvent(new Event("emberyx:keybindings"));
  };

  useEffect(() => {
    if (!recording) return;
    const target = recording;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(e);
      // A bare modifier isn't a binding yet — keep listening for the real key.
      if (!chord || !(chord.mod || chord.alt)) return;
      publish(setBinding(target, formatChord(chord)));
      setRecording(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <>
      <Group title="Commands">
        <div className="grid gap-1">
          {COMMANDS.map((command) => (
            <div
              key={command.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm odd:bg-secondary/30"
            >
              <span className="min-w-0 truncate text-muted-foreground">
                {command.label}
                {clashing.has(command.id) && (
                  <span className="ml-2 text-xs text-destructive">
                    same keys as another command
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {command.rebindable ? (
                  <button
                    type="button"
                    onClick={() => setRecording(command.id)}
                    className="rounded border bg-background px-1.5 py-0.5 text-xs transition-colors hover:bg-accent"
                  >
                    {recording === command.id
                      ? "Press keys…"
                      : displayChord(bindings[command.id])}
                  </button>
                ) : (
                  <kbd
                    title="Owned by the app menu, which sees the keys first"
                    className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {displayChord(bindings[command.id])}
                  </kbd>
                )}
                {command.rebindable &&
                  bindings[command.id] !== command.defaultKey && (
                    <button
                      type="button"
                      onClick={() => publish(resetBinding(command.id))}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                  )}
              </div>
            </div>
          ))}
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => publish(resetAllBindings())}
          >
            Reset all shortcuts
          </Button>
        </div>
      </Group>

      <Group title="Composer">
        <div className="grid gap-1">
          {COMPOSER_KEYS.map((s) => (
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
      </Group>
    </>
  );
}

/** Faces offered for the chat, composer and thread list. Sans first: the
 *  conversation is prose, not a terminal grid, but a monospace chat is a real
 *  preference so the mono stacks stay on the list. */
const INTERFACE_FONT_OPTIONS: { label: string; value: string }[] = [
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
function FontSelect({
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
    <div className="relative w-28">
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
