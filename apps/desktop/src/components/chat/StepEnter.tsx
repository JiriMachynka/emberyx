/**
 * A live turn's tool steps arrive in bursts — three tool calls land in one
 * snapshot and would pop in as a block. Each arriving step is queued instead:
 * it waits for the one before it to finish entering, then rises into the
 * layout with a paced fade, so a burst reads as work happening rather than a
 * jump cut.
 *
 * The first few play at `STEP_ENTRANCE_MS`; a queue running past
 * `STEP_QUEUE_CALM_MS` plays the rest faster, down to `STEP_ENTRANCE_MIN_MS`
 * by `STEP_QUEUE_MS`, so a long burst still catches up. Timing and queue
 * adapted from MonoCode's `PhaseStep` (MIT); the entrance itself is a plain
 * fade-and-rise rather than its rail.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const STEP_ENTRANCE_MS = 480;
const STEP_ENTRANCE_MIN_MS = 160;
const STEP_QUEUE_CALM_MS = 960;
const STEP_QUEUE_MS = 2000;

export type StepTurn = { wait: number; pace: number };

/** A group's queue of arriving steps: how long each waits for the step before
 *  it, and how long its own entrance then takes. A step keeps the turn it was
 *  first given however often the group renders. */
export function useStepQueue() {
  const queue = useRef({ next: 0, turns: new Map<string, StepTurn>() });

  return (id: string): StepTurn => {
    const { turns } = queue.current;
    let turn = turns.get(id);
    if (!turn) {
      const now = performance.now();
      const start = Math.max(now, queue.current.next);
      const wait = start - now;
      const backlog =
        (STEP_QUEUE_MS - wait) / (STEP_QUEUE_MS - STEP_QUEUE_CALM_MS);
      const pace = Math.max(
        STEP_ENTRANCE_MIN_MS,
        STEP_ENTRANCE_MS * Math.min(1, backlog)
      );
      queue.current.next = start + pace;
      turn = { wait, pace };
      turns.set(id, turn);
    }
    return turn;
  };
}

/**
 * One arriving step. A step that lands while you watch waits its turn, then
 * rises into the layout with a paced fade; one that was already on screen when
 * the group mounted is history and does not animate. The row is kept out of
 * the layout until its turn, so a burst queues instead of shoving the list.
 */
export function StepEnter({
  turn: arrival,
  children,
}: {
  /** Set only on the render a step arrives in; later renders drop it. */
  turn?: StepTurn;
  children: ReactNode;
}) {
  const [turn] = useState(arrival);
  const [stage, setStage] = useState<"waiting" | "entering" | "settled">(() =>
    !turn ? "settled" : turn.wait > 0 ? "waiting" : "entering"
  );

  useEffect(() => {
    if (stage !== "waiting" || !turn) return;
    const timer = window.setTimeout(() => setStage("entering"), turn.wait);
    return () => window.clearTimeout(timer);
  }, [stage, turn]);

  if (stage === "waiting") return null;

  return (
    <div
      className="step-enter"
      style={
        turn
          ? ({ "--step-ms": `${Math.round(turn.pace)}ms` } as CSSProperties)
          : undefined
      }
      data-entering={stage === "entering" || undefined}
      onAnimationEnd={(e) => {
        if (e.animationName === "step-enter-in" && e.target === e.currentTarget) {
          setStage("settled");
        }
      }}
    >
      {children}
    </div>
  );
}
