import { useState } from "react";

export interface Settings {
  /** Base agent command run on project open. */
  agentCommand: string;
  /** Terminal font-family stack. */
  fontFamily: string;
  /** Terminal font size in px. */
  fontSize: number;
  /** Terminal scrollback in lines. */
  scrollback: number;
}

export const DEFAULT_SETTINGS: Settings = {
  agentCommand: "claude",
  fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
  fontSize: 13,
  scrollback: 1000,
};

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
