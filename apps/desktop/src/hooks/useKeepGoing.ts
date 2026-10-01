/**
 * The keep-going loop's transport-neutral half: the flag ref, the wrap of the
 * originating prompt, and what an idle turn does next. Each chat hook keeps
 * its own delivery path and drain guard; this only decides.
 */

import { useCallback, useRef } from "react";
import {
  isKeepGoingOn,
  planIdle,
  prepareSend,
  type KeepGoing,
} from "@/lib/keepGoing";

type Usage = { costUsd?: number };

export const useKeepGoing = ({
  keepGoing,
  onKeepGoingTurn,
  onKeepGoingStop,
}: {
  keepGoing?: KeepGoing | null;
  onKeepGoingTurn?: (next: KeepGoing) => void;
  onKeepGoingStop?: () => void;
}) => {
  // Read through refs so bumping turns never rebuilds a transport callback —
  // on Claude that would respawn the process.
  const flagRef = useRef(keepGoing ?? null);
  flagRef.current = keepGoing ?? null;
  const onTurnRef = useRef(onKeepGoingTurn);
  onTurnRef.current = onKeepGoingTurn;
  const onStopRef = useRef(onKeepGoingStop);
  onStopRef.current = onKeepGoingStop;

  const advance = useCallback((next: KeepGoing) => {
    flagRef.current = next;
    onTurnRef.current?.(next);
  }, []);

  /** Unattended right now: asks are auto-rejected and idle reads as working. */
  const isOn = useCallback(
    (usage: Usage) => isKeepGoingOn(flagRef.current, usage),
    []
  );

  const wrap = useCallback(
    (text: string, usage: Usage) => {
      const { wire, next } = prepareSend(flagRef.current, text, usage, Date.now());
      if (next) advance(next);
      return wire;
    },
    [advance]
  );

  const stop = useCallback(() => {
    if (!flagRef.current) return;
    flagRef.current = null;
    onStopRef.current?.();
  }, []);

  /** Call on idle with an empty queue. "continue" means the bump is already
   *  persisted and the caller owes `CONTINUE_PROMPT`; "done" means the flag
   *  was cleared and the sticky status has to be re-synced. */
  const idle = useCallback(
    (usage: Usage, messages: { role: string; text: string }[]) => {
      const step = planIdle({ flag: flagRef.current, usage, now: Date.now(), messages });
      if (step.kind === "continue") advance(step.next);
      else if (step.kind === "done") stop();
      return step.kind;
    },
    [advance, stop]
  );

  return { isOn, wrap, stop, idle };
};
