import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { logLines, logVersion, resizeLog, subscribeLog } from "@/lib/ptyLog";
import { highlightAnsi } from "@/lib/shiki";
import { stripAnsi } from "@/lib/accountState";

interface AnsiLogProps {
  sessionId: string;
  fontFamily: string;
  fontSize: number;
  /** Only the visible log follows output and polls the highlighter. */
  active: boolean;
  /** Interactive shells skip async whole-buffer highlighting to stay responsive. */
  plain?: boolean;
}

/** How long a stream must stay quiet before we re-highlight. Bursty output
 *  (a package install) settles into one pass instead of one per event. */
const SETTLE_MS = 80;

/**
 * Read-only view over a ptyLog session: ANSI colors as styled spans, no
 * terminal grid. Unmounting never touches the process — the buffer lives in
 * lib/ptyLog, so a reopened tab re-renders everything it missed.
 */
export function AnsiLog({ sessionId, fontFamily, fontSize, active, plain }: AnsiLogProps) {
  if (plain) {
    return (
      <PlainLog
        sessionId={sessionId}
        fontFamily={fontFamily}
        fontSize={fontSize}
        active={active}
      />
    );
  }

  const [html, setHtml] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const renderedVersion = useRef(-1);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    let inFlight = false;

    const render = () => {
      const version = logVersion(sessionId);
      if (inFlight || version === renderedVersion.current) return;
      inFlight = true;
      renderedVersion.current = version;
      void highlightAnsi(logLines(sessionId).join("\n")).then((out) => {
        inFlight = false;
        if (disposed) return;
        setHtml(out);
        // Output that arrived while highlighting gets the next pass.
        if (logVersion(sessionId) !== version) schedule();
      });
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(render, SETTLE_MS);
    };

    const unsubscribe = subscribeLog(sessionId, schedule);
    render();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [sessionId, active]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // Follow the tail while the reader is parked at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [html]);

  // The child still deserves a sane COLUMNS: report a width derived from the
  // container so wrapped output and SIGWINCH reflow stay reasonable.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const report = () => {
      const cols = Math.max(40, Math.floor(el.clientWidth / (fontSize * 0.6)));
      const rows = Math.max(10, Math.floor(el.clientHeight / (fontSize * 1.4)));
      void resizeLog(sessionId, cols, rows);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessionId, active, fontSize]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="ansi-log h-full w-full overflow-auto rounded-md bg-background"
      style={{ fontFamily, fontSize: `${fontSize}px` }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function PlainLog({ sessionId, fontFamily, fontSize, active }: Omit<AnsiLogProps, "plain">) {
  const version = useSyncExternalStore(
    (onStoreChange) => (active ? subscribeLog(sessionId, onStoreChange) : () => {}),
    () => logVersion(sessionId),
    () => 0,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [version]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const report = () => {
      const cols = Math.max(40, Math.floor(el.clientWidth / (fontSize * 0.6)));
      const rows = Math.max(10, Math.floor(el.clientHeight / (fontSize * 1.4)));
      void resizeLog(sessionId, cols, rows);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessionId, active, fontSize]);

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="ansi-log h-full w-full overflow-auto rounded-md bg-background"
      style={{ fontFamily, fontSize: `${fontSize}px` }}
    >
      <pre className="m-0 whitespace-pre-wrap break-words p-3 font-inherit">
        {logLines(sessionId).map(stripAnsi).join("\n")}
      </pre>
    </div>
  );
}
