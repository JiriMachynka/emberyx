import { createContext, useContext } from "react";

/**
 * Rows the user has clicked in a live turn.
 *
 * A live turn drops rows once they finish and folds the whole log away when
 * the work stops — right for a glance, wrong for a row the user is reading.
 * Clicking one pins it: the row stays, and the log stays open around it.
 */
export type WorkPin = {
  pinned: ReadonlySet<string>;
  pin: (ids: string[]) => void;
};

const none: WorkPin = { pinned: new Set(), pin: () => {} };

export const WorkPinContext = createContext(none);

export const useWorkPin = () => useContext(WorkPinContext);
