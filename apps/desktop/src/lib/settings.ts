import { useState } from "react";

export interface Settings {
  /** Which agent surface opens with a project: rich chat UI or the raw terminal. */
  agentUi: "chat" | "terminal";
  /** Base agent command run on project open. */
  agentCommand: string;
  /** Terminal + chat font-family stack. */
  fontFamily: string;
  /** Editor font-family stack, kept separate so the editor can use a font
   *  whose ligatures render correctly. */
  editorFontFamily: string;
  /** Terminal + chat font size in px. */
  fontSize: number;
  /** Built-in file editor font size in px. */
  editorFontSize: number;
  /** Terminal scrollback in lines. */
  scrollback: number;
  /** Launch Claude with --dangerously-skip-permissions. */
  dangerouslySkipPermissions: boolean;
  /** On project open, resume the most recent thread instead of a fresh agent. */
  resumeLatestThread: boolean;
  /** Launch Claude compact (collapsed tool output). Off = full (--verbose). */
  compactSession: boolean;
  /** Dokploy server base URL, e.g. https://dokploy.example.com. */
  dokployUrl: string;
  /** Dokploy API key (sent as x-api-key). */
  dokployApiKey: string;
  /** OpenRouter API key for generating commit messages. */
  openRouterApiKey: string;
  /** OpenRouter model slug, e.g. anthropic/claude-3.5-haiku. */
  openRouterModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  agentUi: "chat",
  agentCommand: "claude",
  fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
  editorFontFamily:
    '"JetBrains Mono Variable", "Geist Mono Variable", ui-monospace, Menlo, monospace',
  fontSize: 13,
  editorFontSize: 13,
  scrollback: 1000,
  dangerouslySkipPermissions: true,
  resumeLatestThread: false,
  compactSession: false,
  dokployUrl: "",
  dokployApiKey: "",
  openRouterApiKey: "",
  openRouterModel: "",
};

/** Whether an agent command drives Claude Code (enables thread/usage UI). */
export function isClaudeAgent(cmd: string): boolean {
  return cmd.startsWith("claude");
}

const KEY = "emberyx.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  function update(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }

  return { settings, update };
}
