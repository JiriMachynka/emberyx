/**
 * Temporary performance probe for the React pass (2026-09-11). Inert unless
 * `localStorage["emberyx.perf"] = "1"`; delete once the numbers it exists to
 * produce are in.
 *
 * Three things, reported by `emberyxPerf.report()` in the devtools console:
 * - React commit cost per `<Profiler>` id (Sidebar, ChatPane, Composer).
 * - Thread switches: click → page arrived → transcript painted, then how much
 *   of the next second the main thread was blocked (markdown, highlighting).
 * - Frames over 50ms anywhere, the jank you'd feel while typing or scrolling.
 */
import type { ProfilerOnRenderCallback } from "react";

export const perfOn =
  typeof localStorage !== "undefined" && localStorage.getItem("emberyx.perf") === "1";

interface RenderStat {
  commits: number;
  totalMs: number;
  maxMs: number;
}

interface SwitchStat {
  thread: string;
  pageMs: number | null;
  paintMs: number;
  blockedMs: number;
  worstFrameMs: number;
}

const renders = new Map<string, RenderStat>();
const switches: SwitchStat[] = [];
/** `at` is ms since page load, so a boot-time freeze reads as one. */
let longFrames: { ms: number; at: number }[] = [];
let pending: { thread: string; at: number; pageAt: number | null } | null = null;

/** Accumulate one timed unit of work under `id` — a React commit, or a call
 *  the Profiler can't see (the lexer tokenizes outside render). */
export const record = (id: string, ms: number) => {
  if (!perfOn) return;
  const stat = renders.get(id) ?? { commits: 0, totalMs: 0, maxMs: 0 };
  stat.commits += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  renders.set(id, stat);
};

export const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) =>
  record(id, actualDuration);

/** The user asked for a thread. */
export const markSwitch = (thread: string) => {
  if (perfOn) pending = { thread, at: performance.now(), pageAt: null };
};

/** Its first page is parsed and handed to React. */
export const markPage = () => {
  if (perfOn && pending && pending.pageAt === null) pending.pageAt = performance.now();
};

/** The pane committed with its transcript; measure to the paint after it. */
export const markPainted = () => {
  const started = pending;
  if (!perfOn || !started) return;
  pending = null;
  // rAF runs before the paint, the timeout after it.
  requestAnimationFrame(() =>
    setTimeout(() => {
      const paintedAt = performance.now();
      watchFrames(1000, (blockedMs, worstFrameMs) => {
        const stat: SwitchStat = {
          thread: started.thread.slice(0, 40),
          pageMs: started.pageAt === null ? null : round(started.pageAt - started.at),
          paintMs: round(paintedAt - started.at),
          blockedMs: round(blockedMs),
          worstFrameMs: round(worstFrameMs),
        };
        switches.push(stat);
        console.log("[perf] switch", stat);
      });
    }, 0)
  );
};

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Sum of frame time beyond a 60fps budget over the next `ms`, and the worst frame. */
const watchFrames = (ms: number, done: (blockedMs: number, worstMs: number) => void) => {
  let last = performance.now();
  const end = last + ms;
  let blocked = 0;
  let worst = 0;
  const tick = (now: number) => {
    const gap = now - last;
    if (gap > 20) blocked += gap - 16.7;
    worst = Math.max(worst, gap);
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else done(blocked, worst);
  };
  requestAnimationFrame(tick);
};

const report = () => {
  console.log("[perf] React commits (actualDuration, ms)");
  console.table(
    Object.fromEntries(
      [...renders].map(([id, s]) => [
        id,
        {
          commits: s.commits,
          totalMs: round(s.totalMs),
          avgMs: round(s.totalMs / s.commits),
          maxMs: round(s.maxMs),
        },
      ])
    )
  );
  console.log("[perf] thread switches (ms)");
  console.table(switches);
  const worst = [...longFrames].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(
    `[perf] frames over 50ms: ${longFrames.length}` +
      (worst.length
        ? `, worst ${worst.map((f) => `${round(f.ms)}ms @${round(f.at / 1000)}s`).join(", ")}`
        : "")
  );
  renders.clear();
  switches.length = 0;
  longFrames = [];
};

declare global {
  interface Window {
    emberyxPerf?: { report: () => void };
  }
}

if (perfOn && typeof window !== "undefined") {
  window.emberyxPerf = { report };
  let last = performance.now();
  const loop = (now: number) => {
    // Past 2s the window was hidden and rAF paused — not jank.
    if (now - last > 50 && now - last < 2000) longFrames.push({ ms: now - last, at: last });
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  console.log("[perf] probe on — emberyxPerf.report() prints and resets");
}
