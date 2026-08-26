export interface Change {
  id: number;
  session: string;
  file: string;
  tool: string;
  oldText: string;
  newText: string;
  time: number;
}

let changeCounter = 0;

/** Next change id. Shared so every producer draws from one sequence — ids are
 *  the feed's React keys. */
export const nextChangeId = () => ++changeCounter;
