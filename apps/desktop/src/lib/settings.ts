import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  CONFIG_DIR_ENV,
  backendFromCommand,
  capabilitiesOf,
  isAgentBackend,
  type AgentBackend,
} from "@/lib/agentBackend";
import { tokenize } from "@/lib/ide";
import type { IdeId } from "@/lib/ide";
import {
  DEFAULT_THEME,
  applyTheme,
  isThemeId,
  type ThemeId,
} from "@/lib/themes";
import {
  applyWindowOpacity,
  clampWindowOpacity,
} from "@/lib/windowOpacity";
import { applyWallpaper } from "@/lib/wallpaper";

/** Claude Code's own permission modes, in increasing order of autonomy. */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ThreadView = "project" | "all";

export type ThreadGrouping = "none" | "repository";

/** One name/value injected into the agent process. Empty names are dropped. */
export interface LaunchEnv {
  name: string;
  value: string;
}

/** Per-backend launch override: a binary to use instead of the backend's own,
 *  plus extra CLI args (tokenized, appended after the built-in flags so a
 *  repeated flag wins). Empty strings mean "no override". */
export interface ProviderLaunch {
  command: string;
  args: string;
  /** The CLI's config directory, exported as `CONFIG_DIR_ENV[backend]`.
   *  Empty uses the CLI default. */
  configDir?: string;
  env?: LaunchEnv[];
}

/** An extra named launch of one backend: work vs personal, OpenRouter, a
 *  local router. The default is `providerLaunch[backend]`; these sit beside it
 *  in the picker. */
export interface LaunchProfile extends ProviderLaunch {
  id: string;
  name: string;
  backend: AgentBackend;
}

/** Codex's sandbox posture; "" keeps the current behavior, which derives it
 *  from the permission switches. The other values mirror `codex --sandbox`. */
export type CodexSandbox =
  | ""
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export const CODEX_SANDBOXES: readonly CodexSandbox[] = [
  "",
  "read-only",
  "workspace-write",
  "danger-full-access",
];

export const CODEX_SANDBOX_LABEL: Record<CodexSandbox, string> = {
  "": "Default",
  "read-only": "Read-only",
  "workspace-write": "Workspace writes",
  "danger-full-access": "Full access",
};

// Membership, not `in`: "toString" is on every object's prototype chain.
export const isCodexSandbox = (value: string): value is CodexSandbox =>
  CODEX_SANDBOXES.some((s) => s === value);

/** How much the agent may do without asking. Claude splits this across two
 *  flags — `--permission-mode` and `--dangerously-skip-permissions`, which are
 *  mutually exclusive — but to the user it is one axis, so the composer offers
 *  one control and `accessLevelToSettings` splits it apart at spawn time. */
export const ACCESS_LEVELS = ["ask", "acceptEdits", "full"] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABEL: Record<AccessLevel, string> = {
  ask: "Ask every time",
  acceptEdits: "Accept edits",
  full: "Full access",
};

/** The stored pair as the composer shows it. `bypassPermissions` reads as full
 *  access whether or not the skip flag is also set — it is the same posture,
 *  and showing "Accept edits" for it would understate what the agent can do. */
export const accessLevelFrom = (
  mode: PermissionMode,
  skipPermissions: boolean
): AccessLevel => {
  if (skipPermissions || mode === "bypassPermissions") return "full";
  return mode === "acceptEdits" ? "acceptEdits" : "ask";
};

/** The composer's choice as the pair the spawn needs. Total in both directions:
 *  `accessLevelFrom` of this result is always the level passed in. */
export const accessLevelToSettings = (
  level: AccessLevel
): { permissionMode: PermissionMode; skipPermissions: boolean } => {
  if (level === "full") {
    return { permissionMode: "bypassPermissions", skipPermissions: true };
  }
  return {
    permissionMode: level === "acceptEdits" ? "acceptEdits" : "default",
    skipPermissions: false,
  };
};


export interface Settings {
  /** Which agent CLI the command drives, and so which features are offered.
   *  Projects may override it; this is the default for new ones. */
  agentBackend: AgentBackend;
  /** Agent CLI binary (used to resolve auth flows and backend inference). */
  agentCommand: string;
  /** Which dark theme paints the surfaces and the accent. All are dark —
   *  Emberyx is terminal-first and has no light mode. */
  theme: ThemeId;
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
  /** Git remote used for GitLab fetch/checkout. The token itself lives in the
   *  OS keychain, never here. */
  gitlabRemote: string;
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
  /** Per-backend binary + extra launch args for chat agents. */
  providerLaunch: Partial<Record<AgentBackend, ProviderLaunch>>;
  /** Extra named launches per backend; the default is `providerLaunch[b]`. */
  launchProfiles: LaunchProfile[];
  /** Codex sandbox posture; "" follows the permission switches. */
  codexSandbox: CodexSandbox;
  /** Working-tree diffs hide whitespace-only changes. */
  diffIgnoreWhitespace: boolean;
  /** Model that drafts commit messages from the diff. "" turns drafting off.
   *  A bare id is Claude (`claude -p`). `codex:`, `opencode:` and `grok:` name
   *  another CLI — see `lib/commitDraft.ts`, which Rust parses the same way. */
  commitMessageModel: string;
  /** Wrap long lines in the built-in editor. */
  wordWrap: boolean;
  /** Right-hand dock (terminal, preview, review, merge requests). Off hides
   *  it until turned back on — those surfaces have nowhere else to go. */
  rightDock: boolean;
  /** Window chrome opacity, 50–100. 100 is fully solid; lower lets the
   *  desktop (or the background image) show through the sidebar and chat
   *  canvas. */
  windowOpacity: number;
  /** File name of the custom background in the app data dir; "" for none. */
  windowBackground: string;
}

export const DEFAULT_SETTINGS: Settings = {
  agentBackend: "claude",
  agentCommand: "claude",
  theme: DEFAULT_THEME,
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
  persistentAgents: true,
  model: "",
  effort: "",
  expandAllProjects: false,
  threadView: "project",
  threadSettleDays: 3,
  threadAutoSettleOnMerge: true,
  threadGrouping: "none",
  gitlabRemote: "origin",
  notifyOnDone: true,
  notifyOnError: true,
  notifyOnAccountIssue: true,
  notifyOnlyWhenUnfocused: false,
  notifySound: false,
  providerLaunch: {},
  launchProfiles: [],
  codexSandbox: "",
  diffIgnoreWhitespace: false,
  commitMessageModel: "claude-haiku-4-5",
  wordWrap: false,
  rightDock: true,
  windowOpacity: 100,
  windowBackground: "",
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

/** A theme that no longer ships would leave every themed token unset and the
 *  app painted in whatever `index.css` declared last, so fall back to Ember. */
const dropStoredUnknownTheme = (s: Settings): Settings =>
  isThemeId(s.theme) ? s : { ...s, theme: DEFAULT_SETTINGS.theme };

const coerceLayout = (s: Settings): Settings => ({
  ...s,
  rightDock: s.rightDock !== false,
});

const coerceWindowOpacity = (s: Settings): Settings => ({
  ...s,
  windowOpacity: clampWindowOpacity(
    typeof s.windowOpacity === "number"
      ? s.windowOpacity
      : DEFAULT_SETTINGS.windowOpacity
  ),
  windowBackground:
    typeof s.windowBackground === "string"
      ? s.windowBackground
      : DEFAULT_SETTINGS.windowBackground,
});

/** Dropped settings: OpenRouter commit generate, first-party Dokploy API,
 *  and the classic/column workspace switch (the rail + column is the only map). */
const dropStoredRemovedKeys = (
  s: Settings & {
    openRouterApiKey?: string;
    openRouterModel?: string;
    dokployUrl?: string;
    dokployApiKey?: string;
    workspaceLayout?: string;
  }
): Settings => {
  const next = { ...s };
  delete next.openRouterApiKey;
  delete next.openRouterModel;
  delete next.dokployUrl;
  delete next.dokployApiKey;
  delete next.workspaceLayout;
  return next;
};

/** Profiles were Claude-only and stored as `claudeProfiles`, without a
 *  backend. Lifted once into `launchProfiles`; the old key is dropped. */
const liftClaudeProfiles = (
  s: Settings & { claudeProfiles?: Omit<LaunchProfile, "backend">[] }
): Settings => {
  const { claudeProfiles, ...rest } = s;
  if (!claudeProfiles) return rest;
  const lifted = claudeProfiles.map((p) => ({ ...p, backend: "claude" as const }));
  return {
    ...rest,
    launchProfiles: Array.isArray(s.launchProfiles) && s.launchProfiles.length
      ? s.launchProfiles
      : lifted,
  };
};

const PERSISTENT_DEFAULT_KEY = "emberyx.persistentAgentsDefaulted";

/** Persistent agents used to default off, and settings are stored whole, so a
 *  stored `false` is the old default rather than a choice. Flipped once and
 *  written back; turning it off afterwards sticks. */
const flipStoredPersistentDefault = (
  stored: Partial<Settings>
): Partial<Settings> => {
  if (localStorage.getItem(PERSISTENT_DEFAULT_KEY)) return stored;
  localStorage.setItem(PERSISTENT_DEFAULT_KEY, "1");
  if (stored.persistentAgents !== false) return stored;
  const next = { ...stored, persistentAgents: true };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
};

/** Reads the stored settings. Exported for callbacks that outlive a render and
 *  so must not close over a `useSettings` snapshot. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const stored = flipStoredPersistentDefault(
      JSON.parse(raw) as Partial<Settings>
    );
    const merged = liftClaudeProfiles(
      coerceWindowOpacity(
        coerceLayout(
          dropStoredRemovedKeys(
            dropStoredUnknownTheme(
              dropStoredPlanMode(
                splitStoredEffort({ ...DEFAULT_SETTINGS, ...stored })
              )
            )
          )
        )
      )
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

export interface ResolvedLaunch {
  command: string | null;
  args: string[];
  configDir: string | null;
  env: Record<string, string>;
}

const envMap = (rows: LaunchEnv[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const row of rows ?? []) {
    const name = row.name.trim();
    if (name) out[name] = row.value;
  }
  return out;
};

/** The config dir rides in `env` under the backend's own variable, after the
 *  user's rows so the dedicated field wins — every transport already carries
 *  `env` to both its local and its daemon spawn. */
const resolveLaunch = (
  backend: AgentBackend,
  launch: ProviderLaunch | undefined
): ResolvedLaunch => {
  const configDir = capabilitiesOf(backend).configDirOverride
    ? launch?.configDir?.trim() || null
    : null;
  const env = envMap(launch?.env);
  if (configDir) env[CONFIG_DIR_ENV[backend]] = configDir;
  return {
    command: launch?.command.trim() || null,
    args: tokenize(launch?.args ?? ""),
    configDir,
    env,
  };
};

/** The profiles one backend can pick between. */
export const profilesFor = (
  profiles: LaunchProfile[],
  backend: AgentBackend
): LaunchProfile[] =>
  capabilitiesOf(backend).launchProfiles
    ? profiles.filter((p) => p.backend === backend)
    : [];

/** Resolved launch override for one backend (or one of its named profiles). A
 *  fresh object per call — memoize at the call site if it feeds an effect. */
export const launchFor = (
  settings: Pick<Settings, "providerLaunch" | "launchProfiles">,
  backend: AgentBackend,
  profileId?: string | null
): ResolvedLaunch => {
  // A profile is one backend's launch line; an id carried across a provider
  // switch must not spawn this CLI with arguments meant for another.
  const profile = profileId
    ? profilesFor(settings.launchProfiles, backend).find((p) => p.id === profileId)
    : undefined;
  return resolveLaunch(backend, profile ?? settings.providerLaunch[backend]);
};

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

  useLayoutEffect(() => {
    applyTheme(settings.theme);
    applyWindowOpacity(
      settings.windowOpacity,
      settings.theme,
      settings.windowBackground !== ""
    );
  }, [settings.theme, settings.windowOpacity, settings.windowBackground]);

  useEffect(() => {
    void applyWallpaper(settings.windowBackground);
  }, [settings.windowBackground]);

  // Identity-stable: it is a prop on every settings surface, and a fresh
  // closure per render defeats their memos — the mounted-but-hidden Settings
  // page re-rendered on every unrelated App state change because of it.
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      // Written by a build where persistence is the default, so a stored
      // `false` from here on is a choice the one-time flip must leave alone.
      localStorage.setItem(PERSISTENT_DEFAULT_KEY, "1");
      return next;
    });
  }, []);

  return { settings, update };
}
