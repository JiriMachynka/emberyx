import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { RotateCcw, Search } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { cn } from "@/lib/utils";
import { checkForUpdates } from "@/lib/update";
import {
  invalidateDaemon,
  useDaemonHealth,
  useForgeCliStatus,
  useProviderStatus,
} from "@/lib/queries";
import { McpSection } from "@/components/McpSection";
import { SkillsSection } from "@/components/SkillsSection";
import { TABS, TAB_META, defaultsFor, type Tab } from "@/components/settings/tabs";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { JevSection } from "@/components/settings/JevSection";
import { ConnectionsSection } from "@/components/settings/ConnectionsSection";
import { SnapshotsSection } from "@/components/settings/SnapshotsSection";
import { SourceControlSection } from "@/components/settings/SourceControlSection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { AboutSection } from "@/components/settings/AboutSection";
import type { AgentBackend } from "@/lib/agentBackend";
import type { Settings } from "@/lib/settings";

interface SettingsPageProps {
  /** False while the page is mounted but hidden. The page keeps its state
   *  between visits, so everything that reaches outside its own subtree — the
   *  window key handler, the subprocess probes, the sidebar portal — is gated
   *  on this rather than on being mounted. */
  active: boolean;
  onBack: () => void;
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}

/** Memoized because the page stays mounted once opened — it is merely hidden —
 *  so without this every unrelated App state change rebuilt all ten sections
 *  behind the workspace. Its props are identity-stable for the same reason. */
export const SettingsPage = memo(function SettingsPage({
  active,
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
    useProviderStatus(active && (tab === "providers" || tab === "about")).data ??
    [];
  const forgeClis =
    useForgeCliStatus(active && tab === "sourceControl").data ?? [];
  const daemon =
    useDaemonHealth(active && (tab === "connections" || tab === "about")).data ??
    null;
  const [startingDaemon, setStartingDaemon] = useState(false);
  const [hiddenDraft, setHiddenDraft] = useState("");
  const [customBackend, setCustomBackend] = useState<AgentBackend>("claude");
  const [customDraft, setCustomDraft] = useState("");
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);

  const meta = TAB_META(tab);
  // The Sidebar creates this host in the same commit that reveals this page, so
  // reading it during render finds nothing and the whole tab list is skipped
  // until some unrelated state change re-renders. Read it after the commit,
  // before paint — and re-read on every reveal, because the Sidebar drops the
  // host while Settings is hidden and builds a fresh one on the way back in.
  const [navigationTarget, setNavigationTarget] = useState<HTMLElement | null>(
    null
  );
  useLayoutEffect(() => {
    setNavigationTarget(
      active ? document.getElementById("settings-navigation") : null
    );
  }, [active]);

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
    if (!active) return;
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
  }, [active, onBack]);

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
          ? `running v${daemon.version}, pid ${daemon.pid}, ${daemon.liveCount} live of ${daemon.agentCount} agent(s), ${daemon.eventCount} event(s)`
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
                  ? "surface-raised bg-primary/15 font-medium text-foreground ring-1 ring-inset ring-primary/25"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
            >
              {/* One of the three places the ember shows up on this page: the
                  surface you are on, the focus ring, and a switch that is on. */}
              <t.icon
                className={cn(
                  "size-4 shrink-0",
                  tab === t.id ? "text-primary" : "opacity-80"
                )}
              />
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
            <span className="font-medium text-foreground">{meta.label}</span>
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
          {/* max-w-3xl, not 4xl: past this the label and its value stop reading
              as one row and the page turns into a table. */}
          <div className="mx-auto grid w-full max-w-3xl content-start gap-7 px-6 pb-16 pt-4">
            <h1 className="text-xl font-semibold tracking-tight">{meta.label}</h1>


            {tab === "general" && (
              <GeneralSection settings={settings} onUpdate={onUpdate} />
            )}

            {tab === "appearance" && (
              <AppearanceSection settings={settings} onUpdate={onUpdate} />
            )}

            {tab === "shortcuts" && <ShortcutsSection />}

            {tab === "providers" && (
              <ProvidersSection
                settings={settings}
                onUpdate={onUpdate}
                providers={providers}
                hiddenDraft={hiddenDraft}
                setHiddenDraft={setHiddenDraft}
                customBackend={customBackend}
                setCustomBackend={setCustomBackend}
                customDraft={customDraft}
                setCustomDraft={setCustomDraft}
              />
            )}

            {tab === "jev" && (
              <JevSection settings={settings} onUpdate={onUpdate} />
            )}

            {tab === "mcp" && <McpSection />}

            {tab === "skills" && <SkillsSection />}

            {tab === "connections" && (
              <ConnectionsSection
                settings={settings}
                onUpdate={onUpdate}
                daemon={daemon}
                startingDaemon={startingDaemon}
                onStartDaemon={onStartDaemon}
                diagnosticsCopied={diagnosticsCopied}
                copyDiagnostics={copyDiagnostics}
              />
            )}

            {tab === "snapshots" && (
              <SnapshotsSection settings={settings} onUpdate={onUpdate} />
            )}

            {tab === "sourceControl" && (
              <SourceControlSection
                settings={settings}
                onUpdate={onUpdate}
                forgeClis={forgeClis}
              />
            )}

            {tab === "notifications" && (
              <NotificationsSection settings={settings} onUpdate={onUpdate} />
            )}

            {tab === "about" && (
              <AboutSection
                version={version}
                checking={checking}
                onCheckUpdates={onCheckUpdates}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
})
