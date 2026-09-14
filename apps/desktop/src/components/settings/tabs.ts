import {
  Bell,
  Boxes,
  Camera,
  GitBranch,
  Info,
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
  | "themes"
  | "appearance"
  | "shortcuts"
  | "providers"
  | "mcp"
  | "skills"
  | "connections"
  | "snapshots"
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

export const TABS: TabMeta[] = [
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
    ],
    finds: "theme themes color colour accent dark palette ember graphite phosphor crimson sandstone font family size chat terminal editor scrollback typography wrap",
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
    id: "snapshots",
    label: "SnapShots",
    icon: Camera,
    // `snapshotsShortcut` is deliberately absent: no control writes it yet (v1
    // ships only the both-Shifts trigger), and a key no control writes is one
    // Restore resets behind its users' backs.
    keys: ["snapshotsEnabled", "snapshotsIncludeAppText"],
    finds: "snapshot screenshot capture shift window accessibility screen recording input monitoring attach",
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

export const TAB_META = (id: Tab) => TABS.find((t) => t.id === id) as TabMeta;

/** The subset of DEFAULT_SETTINGS a tab owns, for its Restore defaults action. */
export const defaultsFor = (keys: (keyof Settings)[]): Partial<Settings> =>
  Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]]));
