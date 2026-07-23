/** Narrowest a side panel may be dragged. */
export const PANEL_MIN_WIDTH = 280;

const DEFAULT_WIDTH = 384;

const key = (panel: string) => `emberyx.panel.${panel}.width`;

export function getPanelWidth(panel: string): number {
  try {
    const raw = Number(localStorage.getItem(key(panel)));
    return raw >= PANEL_MIN_WIDTH ? raw : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function setPanelWidth(panel: string, width: number): void {
  try {
    localStorage.setItem(key(panel), String(Math.round(width)));
  } catch {
    // Ignore storage failures; the width just won't persist.
  }
}
