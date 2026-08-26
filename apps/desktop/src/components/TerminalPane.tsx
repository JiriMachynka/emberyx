import { useEffect, useRef } from "react";
import { AnsiLog } from "@/components/AnsiLog";
import { killLog, spawnLog, writeLog } from "@/lib/ptyLog";

interface TerminalPaneProps {
  cwd: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  active: boolean;
}

const terminalSessionId = (cwd: string) => `shell:${cwd}`;

const keyInput = (event: React.KeyboardEvent<HTMLDivElement>): string | null => {
  if (event.metaKey || event.altKey) return null;

  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key.length === 1 && key >= "a" && key <= "z") {
      return String.fromCharCode(key.charCodeAt(0) - 96);
    }
    return null;
  }

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    default:
      return event.key.length === 1 ? event.key : null;
  }
};

export function TerminalPane({
  cwd,
  fontFamily,
  fontSize,
  scrollback,
  active,
}: TerminalPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sessionId = terminalSessionId(cwd);

  useEffect(() => {
    void spawnLog({
      sessionId,
      cwd,
      maxLines: scrollback,
    });
    return () => {
      void killLog(sessionId);
    };
  }, [cwd, scrollback, sessionId]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => rootRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  const write = (data: string) => {
    void writeLog(sessionId, data);
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="application"
      aria-label="Terminal"
      className="h-full w-full overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={() => rootRef.current?.focus()}
      onKeyDown={(event) => {
        if (event.repeat) return;
        const data = keyInput(event);
        if (data === null) return;
        event.preventDefault();
        write(data);
      }}
      onPaste={(event) => {
        event.preventDefault();
        write(event.clipboardData.getData("text"));
      }}
    >
      <AnsiLog
        sessionId={sessionId}
        fontFamily={fontFamily}
        fontSize={fontSize}
        active={active}
        plain
      />
    </div>
  );
}
