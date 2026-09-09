import { createContext, useContext } from "react";

/**
 * Whether the pane this subtree renders in is the one on screen.
 *
 * `SessionPanes` keeps up to `PANE_KEEP_ALIVE` panes mounted behind a `hidden`
 * class, so "mounted" and "visible" are different questions. The chat transport
 * already gates its token paints on the pane's `active` prop; this carries that
 * same flag down to the tickers, which have no prop path of their own — they
 * sit under memoized rows several levels below the pane.
 *
 * Defaults to true: a row rendered outside a pane (a test, a permission
 * summary) has no pane to be hidden behind and should behave as it always did.
 */
const PaneVisibleContext = createContext(true);

export const PaneVisibleProvider = PaneVisibleContext.Provider;

export const usePaneVisible = (): boolean => useContext(PaneVisibleContext);
