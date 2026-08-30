/**
 * The app's own keyboard commands, declared once.
 *
 * Before this, the shortcut list lived in three places that could disagree: the
 * `if/else` chain in `useShortcuts`, the command palette's rows, and a
 * hand-written table in Settings. A command is now one row here, and each of
 * those reads it.
 *
 * Chords are written in the portable `mod+shift+f` form — `mod` is ⌘ on macOS
 * and Ctrl elsewhere — and rendered for display by `lib/keybindings.ts`.
 */

export const COMMAND_IDS = [
  "commandPalette.toggle",
  "project.open",
  "agent.new",
  "sidebar.toggle",
  "project.search",
  "tab.next",
  "tab.prev",
  "tab.close",
  "settings.open",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export interface CommandDef {
  id: CommandId;
  label: string;
  defaultKey: string;
  /**
   * False for chords the app doesn't own. AppKit consumes menu key equivalents
   * before the webview sees them, so rebinding one here would change the
   * Settings row and nothing else — which is worse than saying it's fixed.
   */
  rebindable: boolean;
}

export const COMMANDS: readonly CommandDef[] = [
  {
    id: "commandPalette.toggle",
    label: "Command palette",
    defaultKey: "mod+k",
    rebindable: true,
  },
  {
    id: "project.open",
    label: "Open project",
    defaultKey: "mod+o",
    rebindable: true,
  },
  {
    id: "agent.new",
    label: "New agent tab",
    defaultKey: "mod+n",
    rebindable: true,
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    defaultKey: "mod+b",
    rebindable: true,
  },
  {
    id: "project.search",
    label: "Search in project",
    defaultKey: "mod+shift+f",
    rebindable: true,
  },
  {
    id: "tab.next",
    label: "Next tab",
    defaultKey: "ctrl+tab",
    rebindable: true,
  },
  {
    id: "tab.prev",
    label: "Previous tab",
    defaultKey: "ctrl+shift+tab",
    rebindable: true,
  },
  // Both of these are app-menu items; the menu, not this table, is what fires.
  {
    id: "tab.close",
    label: "Close tab",
    defaultKey: "mod+w",
    rebindable: false,
  },
  {
    id: "settings.open",
    label: "Settings",
    defaultKey: "mod+,",
    rebindable: false,
  },
];

export const commandById = (id: CommandId): CommandDef | undefined =>
  COMMANDS.find((c) => c.id === id);
