import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { RotateCcw, Search } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { cn } from "@/lib/utils";
import {
  invalidateDaemon,
  useDaemonHealth,
  useForgeCliStatus,
  useProviderStatus,
} from "@/lib/queries";
import { McpSection } from "@/components/McpSection";
import { SkillsSection } from "@/components/SkillsSection";
import {
  NAV,
  TAB_META,
  defaultsFor,
  type Tab,
} from "@/components/settings/tabs";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectionsSection } from "@/components/settings/ConnectionsSection";
import { SourceControlSection } from "@/components/settings/SourceControlSection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { UsageSection } from "@/components/settings/UsageSection";
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
  /** Jump to this tab when it changes — command palette "Usage & cost". */
  revealTab?: Tab | null;
  onRevealTab?: () => void;
}

/** Memoized because the page stays mounted once opened — it is merely hidden —
 *  so without this every unrelated App state change rebuilt all ten sections
 *  behind the workspace. Its props are identity-stable for the same reason. */
export const SettingsPage = memo(function SettingsPage({
  active,
  onBack,
  settings,
  onUpdate,
  revealTab,
  onRevealTab,
}: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>(revealTab ?? "general");
  useEffect(() => {
    if (!revealTab) return;
    setTab(revealTab);
    onRevealTab?.();
  }, [revealTab, onRevealTab]);
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  // Each of these three is a subprocess sweep on the Rust side — CLI version
  // probes, a keychain read, a socket round trip. They are fetched on the tabs
  // that show them, not on every open: the default tab displays none of them,
  // and paying for all three there is what made Settings feel slow to appear.
  // Connections' diagnostics dump names every provider, so that tab loads both.
  const providers =
    useProviderStatus(active && (tab === "providers" || tab === "connections"))
      .data ?? [];
  const forgeClis =
    useForgeCliStatus(active && tab === "sourceControl").data ?? [];
  const daemon =
    useDaemonHealth(active && tab === "connections").data ?? null;
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
    return NAV.map((n) => ({
      ...n,
      tabs: n.tabs.filter((id) => {
        if (!q) return true;
        const t = TAB_META(id);
        return `${n.label} ${t.label} ${t.finds}`.toLowerCase().includes(q);
      }),
    })).filter((n) => n.tabs.length > 0);
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

  const pane = (id: Tab) => {
    switch (id) {
      case "general":
        return <GeneralSection settings={settings} onUpdate={onUpdate} />;
      case "appearance":
        return <AppearanceSection settings={settings} onUpdate={onUpdate} />;
      case "shortcuts":
        return <ShortcutsSection />;
      case "notifications":
        return (
          <NotificationsSection settings={settings} onUpdate={onUpdate} />
        );
      case "providers":
        return (
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
        );
      case "mcp":
        return <McpSection />;
      case "skills":
        return <SkillsSection />;
      case "connections":
        return (
          <ConnectionsSection
            settings={settings}
            onUpdate={onUpdate}
            daemon={daemon}
            startingDaemon={startingDaemon}
            onStartDaemon={onStartDaemon}
            diagnosticsCopied={diagnosticsCopied}
            copyDiagnostics={copyDiagnostics}
          />
        );
      case "sourceControl":
        return (
          <SourceControlSection
            settings={settings}
            onUpdate={onUpdate}
            forgeClis={forgeClis}
          />
        );
      case "usage":
        return <UsageSection />;
    }
  };

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

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
          {matches.map((n) => (
            <div key={n.id} className="grid gap-0.5">
              <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
                {n.label}
              </p>
              {n.tabs.map((id) => {
                const t = TAB_META(id);
                return (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      tab === id
                        ? "surface-raised bg-primary/15 font-medium text-foreground ring-1 ring-inset ring-primary/25"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                    )}
                  >
                    <t.icon
                      className={cn(
                        "size-5 shrink-0",
                        tab === id ? "text-primary" : "opacity-80"
                      )}
                    />
                    {t.label}
                  </button>
                );
              })}
            </div>
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
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 px-6">
          <h1 className="text-xl font-semibold tracking-tight">{meta.label}</h1>
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
          <div
            data-settings-content
            className={cn(
              "mx-auto grid w-full content-start gap-8 px-6 pb-16 pt-2",
              tab === "usage" ? "max-w-6xl" : "max-w-3xl",
            )}
          >
            {pane(tab)}
          </div>
        </div>
      </div>
    </div>
  );
})
