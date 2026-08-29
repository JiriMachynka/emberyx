import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  Boxes,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Info,
  Keyboard,
  Plus,
  Palette,
  Plug,
  Puzzle,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Type,
  X,
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
  useProviderStatus,
} from "@/lib/queries";
import { IDES, IDE_LABEL, type IdeId } from "@/lib/ide";
import {
  DEFAULT_SETTINGS,
} from "@/lib/settings";
import { PROVIDER_LABEL } from "@/lib/providers";
import {
  CODEX_SANDBOXES,
  CODEX_SANDBOX_LABEL,
  isCodexSandbox,
} from "@/lib/settings";
import { CLAUDE_MODELS } from "@/lib/modelCatalog";
import {
  getCustomModels,
  getHiddenModels,
  setCustomModels,
  setHiddenModels,
} from "@/lib/modelFavorites";
import { Field, Group, Row, SwitchRow } from "@/components/SettingsFields";
import { McpSection } from "@/components/McpSection";
import { SkillsSection } from "@/components/SkillsSection";
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
  isAgentBackend,
  type AgentBackend,
} from "@/lib/agentBackend";
import { THEMES, type Theme } from "@/lib/themes";
import type { LucideIcon } from "lucide-react";
import type { Settings } from "@/lib/settings";

interface SettingsPageProps {
  onBack: () => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}

type Tab =
  | "general"
  | "themes"
  | "appearance"
  | "shortcuts"
  | "providers"
  | "mcp"
  | "skills"
  | "permissions"
  | "connections"
  | "sourceControl"
  | "notifications"
  | "about";

/** Radix Select refuses an empty item value, so "no model" needs a name of its
 *  own on the way through the picker. */
const NO_COMMIT_MODEL = "off";

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
      "threadView",
      "threadGrouping",
      "threadSettleDays",
      "threadAutoSettleOnMerge",
      "expandAllProjects",
      "autoOpenDevPanel",
    ],
    finds: "thread list sidebar settle merge group project dev panel",
  },
  {
    id: "themes",
    label: "Themes",
    icon: Palette,
    keys: ["theme"],
    finds: "theme themes color colour accent dark palette ember graphite phosphor crimson sandstone",
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
    finds: "font family size chat terminal editor scrollback typography",
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
    keys: ["agentBackend", "agentCommand", "providerLaunch", "claudeProfiles", "codexSandbox"],
    finds: "claude codex backend cli command installed version sandbox launch binary args model list hidden custom config dir env profile",
  },
  {
    id: "mcp",
    label: "MCP",
    icon: Puzzle,
    keys: [],
    finds: "mcp servers tools connect stdio http context7 dokploy",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    keys: [],
    finds: "skills slash commands abilities create instructions skil",
  },
  {
    id: "connections",
    label: "Connections",
    icon: Plug,
    keys: [
      "persistentAgents",
      "ide",
      "ideCustomCommand",
    ],
    finds: "daemon emberyxd persistent background editor ide vscode",
  },
  {
    id: "sourceControl",
    label: "Source Control",
    icon: GitBranch,
    keys: ["gitlabRemote", "diffIgnoreWhitespace", "commitMessageModel"],
    finds: "git github gitlab gh glab cli login remote pull request merge request diff whitespace commit message model generate ai",
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
  const qc = useQueryClient();
  // Each of these three is a subprocess sweep on the Rust side — CLI version
  // probes, a keychain read, a socket round trip. They are fetched on the tabs
  // that show them (About reads providers + daemon for its diagnostics dump),
  // not on every open: the default tab displays none of them, and paying for
  // all three there is what made Settings feel slow to appear.
  const providers =
    useProviderStatus(tab === "providers" || tab === "about").data ?? [];
  const forgeClis = useForgeCliStatus(tab === "sourceControl").data ?? [];
  const daemon =
    useDaemonHealth(tab === "connections" || tab === "about").data ?? null;
  const [startingDaemon, setStartingDaemon] = useState(false);
  const [hiddenDraft, setHiddenDraft] = useState("");
  const [customBackend, setCustomBackend] = useState<AgentBackend>("claude");
  const [customDraft, setCustomDraft] = useState("");
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  const meta = TAB_META(tab);
  // The Sidebar creates this host in the same commit that mounts this page, so
  // reading it during render finds nothing and the whole tab list is skipped
  // until some unrelated state change re-renders. Read it after the commit,
  // before paint.
  const [navigationTarget, setNavigationTarget] = useState<HTMLElement | null>(
    null
  );
  useLayoutEffect(() => {
    setNavigationTarget(document.getElementById("settings-navigation"));
  }, []);

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

  function diagnosticsText(): string {
    return [
      `Emberyx ${version || "unknown"}`,
      `Platform: ${navigator.platform}`,
      `User agent: ${navigator.userAgent}`,
      "",
      "Providers:",
      ...providers.map(
        (p) =>
          `- ${p.label} (${p.binary}): ${
            p.installed ? (p.version ?? "installed") : "not installed"
          }`
      ),
      "",
      "Daemon: " +
        (daemon
          ? `running v${daemon.version}, pid ${daemon.pid}, ${daemon.agentCount} agent(s), ${daemon.eventCount} event(s)`
          : "not running"),
    ].join("\n");
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagnosticsText());
      setDiagnosticsCopied(true);
      setTimeout(() => setDiagnosticsCopied(false), 1500);
    } catch {
      // Clipboard blocked — nothing sensible to fall back to in a webview.
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
      {navigationTarget &&
        createPortal(
          <nav className="flex min-h-full w-full flex-col bg-sidebar">
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

          </nav>,
          navigationTarget
        )}

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

            {tab === "themes" && (
              <Group
                title="Theme"
                hint="Every theme is dark — Emberyx is terminal-first and has no light mode. A theme sets the surfaces and the single accent; type, spacing and borders never change."
              >
                <div className="grid grid-cols-2 gap-2.5">
                  {THEMES.map((t) => (
                    <ThemeCard
                      key={t.id}
                      theme={t}
                      selected={settings.theme === t.id}
                      onSelect={() => onUpdate({ theme: t.id })}
                    />
                  ))}
                </div>
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
                    hint="Editor text size in pixels."
                    control={
                      <NumberStepper
                        value={settings.editorFontSize}
                        min={8}
                        max={32}
                        onChange={(n) => onUpdate({ editorFontSize: n })}
                      />
                    }
                  />
                  <SwitchRow
                    label="Wrap long lines"
                    hint="The editor wraps instead of scrolling sideways."
                    checked={settings.wordWrap}
                    onChange={(v) => onUpdate({ wordWrap: v })}
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
                    hint="The agent CLI binary, e.g. claude or codex."
                    control={
                      <Input
                        value={settings.agentCommand}
                        onChange={(e) => onUpdate({ agentCommand: e.target.value })}
                        spellCheck={false}
                      />
                    }
                  />

                  <Row
                    label="Codex sandbox"
                    hint="How much of the machine a Codex thread can touch. Default follows the switches above: full access when permissions are skipped, workspace writes otherwise."
                    control={
                      <Select
                        value={settings.codexSandbox}
                        onValueChange={(v) => {
                          if (isCodexSandbox(v)) onUpdate({ codexSandbox: v });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CODEX_SANDBOXES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {CODEX_SANDBOX_LABEL[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    }
                  />
                </Group>

                <Group
                  title="Model list"
                  hint="What the composer's picker offers. Hidden models drop out of every rail; custom slugs join the provider you assign them to."
                >
                  <Row
                    label="Hidden models"
                    hint="Model ids the picker never offers, whatever a catalog says."
                    control={<span />}
                  >
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={hiddenDraft}
                        onChange={(e) => setHiddenDraft(e.target.value)}
                        placeholder="provider/model-id"
                        spellCheck={false}
                        className="h-7 w-64 font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!hiddenDraft.trim()}
                        onClick={() => {
                          const id = hiddenDraft.trim();
                          if (!id) return;
                          setHiddenModels([...getHiddenModels(), id]);
                          setHiddenDraft("");
                        }}
                      >
                        Hide
                      </Button>
                    </div>
                    {getHiddenModels().length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-2">
                        {getHiddenModels().map((id) => (
                          <span
                            key={id}
                            className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                          >
                            {id}
                            <button
                              type="button"
                              aria-label={`Unhide ${id}`}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() =>
                                setHiddenModels(getHiddenModels().filter((v) => v !== id))
                              }
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </Row>

                  <Row
                    label="Custom models"
                    hint="Extra slugs offered in the picker — new releases, proxies, private endpoints."
                    control={<span />}
                  >
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={customBackend}
                        onValueChange={(v) => {
                          if (isAgentBackend(v)) setCustomBackend(v);
                        }}
                      >
                        <SelectTrigger className="h-7 w-36 text-xs">
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
                      <Input
                        value={customDraft}
                        onChange={(e) => setCustomDraft(e.target.value)}
                        placeholder="model-id"
                        spellCheck={false}
                        className="h-7 w-56 font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!customDraft.trim()}
                        onClick={() => {
                          const id = customDraft.trim();
                          if (!id) return;
                          const current = getCustomModels();
                          setCustomModels({
                            ...current,
                            [customBackend]: [...(current[customBackend] ?? []), id],
                          });
                          setCustomDraft("");
                        }}
                      >
                        Add
                      </Button>
                    </div>
                    {Object.entries(getCustomModels()).some(([, ids]) => ids.length > 0) && (
                      <div className="flex flex-wrap gap-1.5 pt-2">
                        {Object.entries(getCustomModels()).flatMap(([b, ids]) => {
                          if (!isAgentBackend(b)) return [];
                          return (ids ?? []).map((id) => (
                            <span
                              key={`${b}:${id}`}
                              className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                            >
                              <span className="text-muted-foreground">{BACKEND_LABEL[b]}</span>
                              {id}
                              <button
                                type="button"
                                aria-label={`Remove ${id}`}
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  const current = getCustomModels();
                                  const kept = (current[b] ?? []).filter((v) => v !== id);
                                  setCustomModels({ ...current, [b]: kept });
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ));
                        })}
                      </div>
                    )}
                  </Row>
                </Group>

                <Group
                  title="Launch"
                  hint="Per-backend binary and extra arguments for chat agents. Arguments run after the built-in flags, so a repeated flag wins. Empty means the CLI on PATH."
                >
                  {AGENT_BACKENDS.map((b) => {
                    const launch = settings.providerLaunch[b];
                    const setLaunch = (
                      patch: Partial<{
                        command: string;
                        args: string;
                        configDir: string;
                        env: { name: string; value: string }[];
                      }>
                    ) =>
                      onUpdate({
                        providerLaunch: {
                          ...settings.providerLaunch,
                          [b]: {
                            command: launch?.command ?? "",
                            args: launch?.args ?? "",
                            configDir: launch?.configDir ?? "",
                            env: launch?.env ?? [],
                            ...patch,
                          },
                        },
                      });
                    return (
                      <div
                        key={b}
                        className="grid gap-3 border-b pb-5 last:border-0 last:pb-0"
                      >
                        <div className="flex items-center gap-2">
                          <img
                            src={`/provider-icons/${b}.svg`}
                            alt=""
                            className="size-4 object-contain"
                          />
                          <span className="text-sm font-medium">{BACKEND_LABEL[b]}</span>
                        </div>
                        <Field label="Command">
                          <Input
                            value={launch?.command ?? ""}
                            placeholder={b}
                            spellCheck={false}
                            className="font-mono text-sm"
                            onChange={(e) => setLaunch({ command: e.target.value })}
                          />
                        </Field>
                        <Field
                          label="Extra arguments"
                          hint="Tokenized like a shell — quotes group, no shell runs."
                        >
                          <Input
                            value={launch?.args ?? ""}
                            placeholder="--flag value"
                            spellCheck={false}
                            className="font-mono text-sm"
                            onChange={(e) => setLaunch({ args: e.target.value })}
                          />
                        </Field>
                        {b === "claude" && (
                          <Field
                            label="Config directory"
                            hint="CLAUDE_CONFIG_DIR. Empty uses ~/.claude — set this for a second account or a router."
                          >
                            <Input
                              value={launch?.configDir ?? ""}
                              placeholder="~/.claude_work"
                              spellCheck={false}
                              className="font-mono text-sm"
                              onChange={(e) =>
                                setLaunch({ configDir: e.target.value })
                              }
                            />
                          </Field>
                        )}
                        <LaunchEnvRows
                          rows={launch?.env ?? []}
                          onChange={(env) => setLaunch({ env })}
                        />
                      </div>
                    );
                  })}
                </Group>

                <Group
                  title="Claude profiles"
                  hint="Extra named Claudes — work vs personal, OpenRouter, a local router. The Launch section above is the default."
                >
                  {settings.claudeProfiles.map((profile) => {
                    const patch = (next: Partial<typeof profile>) =>
                      onUpdate({
                        claudeProfiles: settings.claudeProfiles.map((p) =>
                          p.id === profile.id ? { ...p, ...next } : p
                        ),
                      });
                    return (
                      <div
                        key={profile.id}
                        className="grid gap-3 border-b pb-5 last:border-0 last:pb-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Input
                            value={profile.name}
                            onChange={(e) => patch({ name: e.target.value })}
                            placeholder="Personal"
                            className="h-8 max-w-56"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              onUpdate({
                                claudeProfiles: settings.claudeProfiles.filter(
                                  (p) => p.id !== profile.id
                                ),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                        <Field label="Command">
                          <Input
                            value={profile.command}
                            placeholder="claude"
                            spellCheck={false}
                            className="font-mono text-sm"
                            onChange={(e) => patch({ command: e.target.value })}
                          />
                        </Field>
                        <Field
                          label="Config directory"
                          hint="CLAUDE_CONFIG_DIR for this profile."
                        >
                          <Input
                            value={profile.configDir}
                            placeholder="~/.claude_personal"
                            spellCheck={false}
                            className="font-mono text-sm"
                            onChange={(e) =>
                              patch({ configDir: e.target.value })
                            }
                          />
                        </Field>
                        <LaunchEnvRows
                          rows={profile.env}
                          onChange={(env) => patch({ env })}
                        />
                      </div>
                    );
                  })}
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onUpdate({
                          claudeProfiles: [
                            ...settings.claudeProfiles,
                            {
                              id: `claude-${Date.now().toString(36)}`,
                              name: "Personal",
                              command: "",
                              args: "",
                              configDir: "",
                              env: [],
                            },
                          ],
                        })
                      }
                    >
                      Add Claude profile
                    </Button>
                  </div>
                </Group>
              </>
            )}

            {tab === "mcp" && <McpSection />}

            {tab === "skills" && <SkillsSection />}

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

                <Group
                  title="Diagnostics"
                  hint="A bug-report snapshot: versions, platform, provider and daemon state. No conversation content ever leaves with it unless you paste it."
                >
                  <Row
                    label="Copy diagnostics"
                    hint="Text to paste into a bug report."
                    control={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void copyDiagnostics()}
                      >
                        {diagnosticsCopied ? "Copied" : "Copy"}
                      </Button>
                    }
                  />
                </Group>
              </>
            )}

            {tab === "sourceControl" && (
              <>
                <Group
                  title="CLIs"
                  hint="Reviews, clone, and publish use the GitHub (gh) and GitLab (glab) CLIs on your PATH. Log in with gh auth login or glab auth login — Emberyx never stores a PAT of its own."
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
                  <SwitchRow
                    label="Hide whitespace changes"
                    hint="Working-tree diffs in the Changes panel skip whitespace-only edits (git -w)."
                    checked={settings.diffIgnoreWhitespace}
                    onChange={(v) => onUpdate({ diffIgnoreWhitespace: v })}
                  />
                  <Row
                    label="Commit message model"
                    hint="Drafts a commit message from the diff when you press Generate in the commit box. One throwaway claude -p call, so the list is Claude's."
                    control={
                      <Select
                        value={settings.commitMessageModel || NO_COMMIT_MODEL}
                        onValueChange={(v) =>
                          onUpdate({
                            commitMessageModel: v === NO_COMMIT_MODEL ? "" : v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_COMMIT_MODEL}>Off</SelectItem>
                          {CLAUDE_MODELS.filter((m) => !m.legacy).map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
/** A theme's own tokens, drawn as a miniature of the app: sidebar rail, chat
 *  canvas, composer, accent. Painted from the theme's values rather than the
 *  live variables, so an unselected card still shows what it would look like. */
function ThemeCard({
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
        "group rounded-lg border p-2 text-left transition-colors",
        selected ? "border-primary" : "hover:border-foreground/20"
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

function LaunchEnvRows({
  rows,
  onChange,
}: {
  rows: { name: string; value: string }[];
  onChange: (rows: { name: string; value: string }[]) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">Environment</span>
      <span className="text-xs text-muted-foreground">
        Injected into the agent process. Use this for ANTHROPIC_BASE_URL /
        ANTHROPIC_AUTH_TOKEN.
      </span>
      <div className="grid gap-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              value={row.name}
              onChange={(e) =>
                onChange(
                  rows.map((r, i) =>
                    i === index ? { ...r, name: e.target.value } : r
                  )
                )
              }
              placeholder="NAME"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <Input
              value={row.value}
              onChange={(e) =>
                onChange(
                  rows.map((r, i) =>
                    i === index ? { ...r, value: e.target.value } : r
                  )
                )
              }
              placeholder="value"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Remove variable"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...rows, { name: "", value: "" }])}
          >
            <Plus className="size-3.5" />
            Add variable
          </Button>
        </div>
      </div>
    </div>
  );
}
