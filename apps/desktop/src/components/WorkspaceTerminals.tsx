import { useEffect, useState } from "react";
import { TerminalPane } from "@/components/TerminalPane";
import { cn } from "@/lib/utils";

interface WorkspaceTerminalsProps {
  projectPath: string;
  /** The terminal tab is the one showing — drives focus and xterm's resize. */
  active: boolean;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
}

/** A shell per project, in the dock's Terminal tab. Every project whose shell
 *  has been opened keeps its pane mounted for the app's lifetime: leaving the
 *  tab — or the project — must not kill the shell or what it is running. */
export function WorkspaceTerminals({
  projectPath,
  active,
  fontFamily,
  fontSize,
  scrollback,
}: WorkspaceTerminalsProps) {
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    if (!projectPath) return;
    setPaths((prev) => (prev.includes(projectPath) ? prev : [...prev, projectPath]));
  }, [projectPath]);

  return (
    <>
      {paths.map((path) => (
        <div
          key={path}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col",
            path === projectPath ? "" : "hidden"
          )}
        >
          <TerminalPane
            sessionId={`surface-term:${path}`}
            cwd={path}
            fontFamily={fontFamily}
            fontSize={fontSize}
            scrollback={scrollback}
            active={active && path === projectPath}
          />
        </div>
      ))}
    </>
  );
}
