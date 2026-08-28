/**
 * The right-hand dock's tab model.
 *
 * Every right-hand surface used to be its own aside, and opening one closed the
 * rest — so a diff and a terminal could never be a keystroke apart. They are
 * tabs of one panel now, and this file is the state behind that strip: which
 * tabs exist, which one is showing, and what happens to the selection when one
 * closes. Pure, so the rules are testable without mounting a panel.
 */

export type DockKind =
  | "terminal"
  | "files"
  | "diff"
  | "preview"
  | "mrs"
  | "dev"
  | "projectSettings";

/** Menu order, and the order tabs are offered in. */
export const DOCK_KINDS: readonly DockKind[] = [
  "terminal",
  "files",
  "diff",
  "preview",
  "mrs",
  "dev",
  "projectSettings",
];

export const DOCK_LABEL: Record<DockKind, string> = {
  terminal: "Terminal",
  files: "Files",
  diff: "Diff",
  preview: "Preview",
  mrs: "Reviews",
  dev: "Output",
  projectSettings: "Project",
};

/**
 * First-open chooser: the surfaces a new dock offers, in the order they are
 * shown. Project settings stay on the header sliders, not here — they are a
 * config page, not a working surface.
 */
export interface DockOffer {
  kind: DockKind;
  shortcut: string;
  blurb: string;
}

export const PICKER_OFFERS = [
  { kind: "terminal", shortcut: "T", blurb: "Start a shell in this workspace." },
  { kind: "preview", shortcut: "B", blurb: "Open a local app or URL." },
  { kind: "files", shortcut: "F", blurb: "Browse and read workspace files." },
  { kind: "diff", shortcut: "D", blurb: "Review uncommitted changes." },
  { kind: "mrs", shortcut: "P", blurb: "Review open requests on this branch." },
  { kind: "dev", shortcut: "O", blurb: "Running servers and command output." },
] as const satisfies readonly DockOffer[];

export interface DockState {
  /** Open tabs, left to right, in the order they were opened. */
  tabs: DockKind[];
  /** The tab being shown. Null while the panel is open is the surface chooser. */
  active: DockKind | null;
  /** The panel is showing. Independent of `active` so the chooser can live
   *  in an open dock that has no tab yet. */
  open: boolean;
}

export const EMPTY_DOCK: DockState = { tabs: [], active: null, open: false };

/** The empty-state chooser: the panel is showing, nothing has been picked. */
export const isChooser = (state: DockState): boolean =>
  state.open && state.active === null;

export function showDock(state: DockState): DockState {
  return state.open ? state : { ...state, open: true };
}

export function hideDock(state: DockState): DockState {
  return state.open ? { ...state, open: false } : state;
}

/** Open a tab (or reveal it if it is already open) and make it the active one. */
export function openTab(state: DockState, kind: DockKind): DockState {
  return {
    tabs: state.tabs.includes(kind) ? state.tabs : [...state.tabs, kind],
    active: kind,
    open: true,
  };
}

/** Close a tab. The selection falls to its left-hand neighbour, so closing the
 *  rightmost tab doesn't jump the dock back to the first one. Closing the last
 *  tab closes the dock: with nothing left to show, holding the panel open on
 *  the chooser keeps width from the chat for a surface the user just dismissed.
 *  The chooser is still where an explicitly opened, empty dock lands. */
export function closeTab(state: DockState, kind: DockKind): DockState {
  const at = state.tabs.indexOf(kind);
  if (at === -1) return state;
  const tabs = state.tabs.filter((t) => t !== kind);
  if (tabs.length === 0) return { tabs, active: null, open: false };
  if (state.active !== kind) return { ...state, tabs };
  return { tabs, active: tabs[at - 1] ?? tabs[at] ?? null, open: true };
}

/** What a toolbar button does: reveal the tab, or close it if it's already the
 *  one showing. An open-but-hidden tab is revealed rather than closed — the
 *  button reads as "show me this". */
export function toggleTab(state: DockState, kind: DockKind): DockState {
  return state.active === kind ? closeTab(state, kind) : openTab(state, kind);
}

/** Drop tabs that belonged to the project being left. */
export function closeTabs(state: DockState, kinds: readonly DockKind[]): DockState {
  return kinds.reduce(closeTab, state);
}
