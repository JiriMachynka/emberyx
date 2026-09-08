/**
 * Where a slow interaction actually goes, in dev only.
 *
 * Structural reads can say a tree *should* be cheap; they cannot say whether a
 * toggle spends its time in React's commit or in the browser's layout and
 * paint afterwards. `<TimedRegion>` wraps a subtree in React's Profiler and
 * logs commits over a threshold, so the answer is measured rather than argued.
 *
 * In production this is the children, unwrapped — no Profiler, no closure, no
 * cost. `import.meta.env.DEV` is a literal at build time, so the branch and the
 * logging code are dropped from the bundle entirely.
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

/** Below this, a commit is noise — React commits constantly at idle. */
const REPORT_OVER_MS = 4;

const report: ProfilerOnRenderCallback = (id, phase, actual, base) => {
  if (actual < REPORT_OVER_MS) return;
  // eslint-disable-next-line no-console
  console.info(
    `[emberyx] ${id} ${phase} commit ${actual.toFixed(1)}ms (full render would be ${base.toFixed(1)}ms)`
  );
};

export function TimedRegion({ id, children }: { id: string; children: ReactNode }) {
  if (!import.meta.env.DEV) return <>{children}</>;
  return (
    <Profiler id={id} onRender={report}>
      {children}
    </Profiler>
  );
}
