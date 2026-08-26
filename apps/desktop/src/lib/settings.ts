import { useLayoutEffect, useState } from "react";
import {
  backendFromCommand,
  isAgentBackend,
  type AgentBackend,
} from "@/lib/agentBackend";
import type { IdeId } from "@/lib/ide";

/** Claude Code's own permission modes, in increasing order of autonomy. */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ThreadView = "project" | "all";

export type ThreadGrouping = "none" | "repository";

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  default: "Ask every time",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
};

export interface Settings {
  /** Which agent CLI the command drives, and so which features are offered.
   *  Projects may override it; this is the default for new ones. */
  agentBackend: AgentBackend;
  /** Agent CLI binary (used to resolve auth flows and backend inference). */
  agentCommand: string;
  /** Monospace stack for PTY output logs (dev servers, Dokploy). */
  fontFamily: string;
  /** Chat, composer and thread-list font stack. Its own axis: logs need a
   *  monospace grid, the conversation around them does not. */
  chatFontFamily: string;
  /** Editor font-family stack, kept separate so the editor can use a font
   *  whose ligatures render correctly. */
  editorFontFamily: string;
  /** Log + chat font size in px. */
  fontSize: number;
  /** Built-in file editor font size in px. */
  editorFontSize: number;
  /** Output-log scrollback in lines. */
  scrollback: number;
  /** Launch Claude with --dangerously-skip-permissions. */
  dangerouslySkipPermissions: boolean;
  /** Editor "Open in IDE" launches. */
  ide: IdeId;
  /** Command for `ide: "custom"`; supports {project} {file} {line} {column}. */
  ideCustomCommand: string;
  /** Claude's `--permission-mode` for new chats. Ignored when permissions are
   *  skipped entirely, which is a separate, blunter switch. */
  permissionMode: PermissionMode;
  /** Run chat agents inside `emberyxd` so they survive closing the window.
   *  Off by default: the daemon owns the process, so a resumed thread renders
   *  from the daemon's replay rather than the CLI transcript on disk. */
  persistentAgents: boolean;
  /** `--model` alias for new chats: "" = CLI default, else opus/sonnet/sonnet[1m]/haiku. */
  model: string;
  /** Reasoning effort for new chats; "" = CLI default. Its own axis, not part
   *  of the model — each backend offers its own levels. */
  effort: string;
  /** Keep every open project's session list expanded, not just the active one. */
  expandAllProjects: boolean;
  /** How resumable threads are organized in the main sidebar. */
  threadView: ThreadView;
  /** Idle days after which a thread drops into the settled group. 0 = never. */
  threadSettleDays: number;
  /** Also settle a thread once its branch has been merged. */
  threadAutoSettleOnMerge: boolean;
  /** Group the active thread list by repository, or leave it flat. */
  threadGrouping: ThreadGrouping;
  /** Open the dev output panel automatically when a dev/build/start run starts. */
  autoOpenDevPanel: boolean;
  /** Dokploy server base URL, e.g. https://dokploy.example.com. */
  dokployUrl: string;
  /** Dokploy API key (sent as x-api-key). */
  dokployApiKey: string;
  /** Git remote used for GitLab fetch/checkout. The token itself lives in the
   *  OS keychain, never here. */
  gitlabRemote: string;
  /** OpenRouter API key for generating commit messages. */
  openRouterApiKey: string;
  /** OpenRouter model slug, e.g. anthropic/claude-3.5-haiku. */
  openRouterModel: string;
  /** Notify when the agent finishes a turn. */
  notifyOnDone: boolean;
  /** Notify when an agent run ends in an error. */
  notifyOnError: boolean;
  /** Notify when the account is blocked — usage limit reached or signed out. */
  notifyOnAccountIssue: boolean;
  /** Only raise OS notifications while the window is unfocused. */
  notifyOnlyWhenUnfocused: boolean;
  /** Play the system sound with OS notifications. */
  notifySound: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  agentBackend: "claude",
  agentCommand: "claude",
  fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
  chatFontFamily: '"DM Sans Variable", ui-sans-serif, system-ui, sans-serif',
  editorFontFamily:
    '"JetBrains Mono Variable", "Geist Mono Variable", ui-monospace, Menlo, monospace',
  fontSize: 13,
  editorFontSize: 13,
  scrollback: 1000,
  dangerouslySkipPermissions: true,
  ide: "vscode",
  ideCustomCommand: "",
  permissionMode: "acceptEdits",
  persistentAgents: false,
  model: "",
  effort: "",
  expandAllProjects: false,
  threadView: "project",
  threadSettleDays: 3,
  threadAutoSettleOnMerge: true,
  threadGrouping: "none",
  autoOpenDevPanel: false,
  dokployUrl: "",
  dokployApiKey: "",
  gitlabRemote: "origin",
  openRouterApiKey: "",
  openRouterModel: "",
  notifyOnDone: true,
  notifyOnError: true,
  notifyOnAccountIssue: true,
  notifyOnlyWhenUnfocused: false,
  notifySound: false,
};

const KEY = "emberyx.settings";

/** Plan-only was dropped as a mode. A stored `"plan"` would still be passed to
 *  `--permission-mode` with nothing in the UI to turn it off, so it reverts to
 *  the default posture. */
const dropStoredPlanMode = (s: Settings): Settings =>
  PERMISSION_MODES.includes(s.permissionMode)
    ? s
    : { ...s, permissionMode: DEFAULT_SETTINGS.permissionMode };

/** Codex once stored its effort inside the model as `id:effort`. Left alone,
 *  that whole string would be sent as a model id, so lift it back out. No
 *  Claude alias contains a colon. */
const splitStoredEffort = (s: Settings): Settings => {
  const at = s.model.indexOf(":");
  if (at === -1) return s;
  return { ...s, model: s.model.slice(0, at), effort: s.model.slice(at + 1) };
};

/** Reads the stored settings. Exported for callbacks that outlive a render and
 *  so must not close over a `useSettings` snapshot. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const stored = JSON.parse(raw) as Partial<Settings>;
    const merged = dropStoredPlanMode(
      splitStoredEffort({ ...DEFAULT_SETTINGS, ...stored })
    );
    // Settings written before the backend was explicit only recorded the
    // command; keep those users on exactly the surface they had.
    return isAgentBackend(stored.agentBackend)
      ? merged
      : { ...merged, agentBackend: backendFromCommand(merged.agentCommand) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Push the chosen stacks onto `:root` so Tailwind `font-sans` / `font-mono`
 *  and Streamdown code fences follow Appearance instead of the hardcoded
 *  theme defaults. Layout-effect so the first paint already matches. */
export const applyFontFamilies = (
  s: Pick<Settings, "chatFontFamily" | "editorFontFamily">,
) => {
  const root = document.documentElement.style;
  root.setProperty("--chat-font", s.chatFontFamily);
  root.setProperty("--code-font", s.editorFontFamily);
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useLayoutEffect(() => {
    applyFontFamilies(settings);
  }, [settings.chatFontFamily, settings.editorFontFamily]);

  function update(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }

  return { settings, update };
}
