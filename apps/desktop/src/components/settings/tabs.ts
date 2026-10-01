import {
  Bell,
  Boxes,
  CircleDollarSign,
  GitBranch,
  Keyboard,
  Palette,
  Plug,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { LucideIcon } from "lucide-react";
import type { Settings } from "@/lib/settings";

export type Tab =
  | "general"
  | "appearance"
  | "shortcuts"
  | "providers"
  | "mcp"
  | "skills"
  | "connections"
  | "sourceControl"
  | "notifications"
  | "usage";

export type NavId = "app" | "agents" | "git" | "account";

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

export interface NavMeta {
  id: NavId;
  label: string;
  tabs: Tab[];
}

export const TABS: TabMeta[] = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    keys: [
      "threadGrouping",
      "threadSettleDays",
      "threadAutoSettleOnMerge",
    ],
    finds: "thread list sidebar settle merge group project",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    keys: [
      "theme",
      "chatFontFamily",
      "fontFamily",
      "editorFontFamily",
      "fontSize",
      "editorFontSize",
      "scrollback",
      "wordWrap",
      "rightDock",
      "windowOpacity",
      "windowBackground",
    ],
    finds: "theme themes color colour accent dark palette ember graphite phosphor crimson sandstone font family size chat terminal editor scrollback typography wrap layout workspace sidebar dock rail sessions explorer changes opacity translucent transparent glass window background",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: Keyboard,
    keys: [],
    finds: "keys keybindings chords shortcuts rebind keyboard",
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
  {
    id: "providers",
    label: "Providers",
    icon: Boxes,
    keys: [
      "agentBackend",
      "agentCommand",
      "providerLaunch",
      "launchProfiles",
      "codexSandbox",
    ],
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
    finds: "git github gitlab gh glab cli login remote pull request merge request diff whitespace commit message model generate ai claude codex opencode grok",
  },
  {
    id: "usage",
    label: "Usage",
    icon: CircleDollarSign,
    keys: [],
    finds: "usage cost tokens spend estimate sessions chart history",
  },
];

/** Sidebar groups. Labels sit above the usual icon rows. */
export const NAV: NavMeta[] = [
  {
    id: "app",
    label: "App",
    tabs: ["general", "appearance", "shortcuts", "notifications"],
  },
  {
    id: "agents",
    label: "Agents",
    tabs: ["providers", "mcp", "skills", "connections"],
  },
  {
    id: "git",
    label: "Git",
    tabs: ["sourceControl"],
  },
  {
    id: "account",
    label: "Account",
    tabs: ["usage"],
  },
];

export const TAB_META = (id: Tab) => TABS.find((t) => t.id === id) as TabMeta;

/** The subset of DEFAULT_SETTINGS a page owns, for its Restore defaults action. */
export const defaultsFor = (keys: (keyof Settings)[]): Partial<Settings> =>
  Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]]));
