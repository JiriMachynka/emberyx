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
  "tab.close",
  "settings.open",
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/** Where a binding applies. `!terminalFocus` keeps a chord out of the terminal,
 *  which has its own claim on most of them. */
export type WhenClause = "always" | "!terminalFocus";

export interface CommandDef {
  id: CommandId;
  label: string;
  defaultKey: string;
  when: WhenClause;
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
    when: "always",
    rebindable: true,
  },
  {
    id: "project.open",
    label: "Open project",
    defaultKey: "mod+o",
    when: "always",
    rebindable: true,
  },
  {
    id: "agent.new",
    label: "New agent tab",
    defaultKey: "mod+t",
    when: "always",
    rebindable: true,
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    defaultKey: "mod+b",
    when: "always",
    rebindable: true,
  },
  {
    id: "project.search",
    label: "Search in project",
    defaultKey: "mod+shift+f",
    when: "always",
    rebindable: true,
  },
  // Both of these are app-menu items; the menu, not this table, is what fires.
  {
    id: "tab.close",
    label: "Close tab",
    defaultKey: "mod+w",
    when: "always",
    rebindable: false,
  },
  {
    id: "settings.open",
    label: "Settings",
    defaultKey: "mod+,",
    when: "always",
    rebindable: false,
  },
];

export const commandById = (id: CommandId): CommandDef | undefined =>
  COMMANDS.find((c) => c.id === id);
