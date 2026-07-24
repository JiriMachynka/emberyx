import { lazy, Suspense } from "react";
import { TerminalPane } from "@/components/TerminalPane";
import { ChatPane } from "@/components/ChatPane";
import { DokployLogsPane } from "@/components/DokployLogsPane";
// CodeMirror is a big chunk; only sessions that open the editor pay for it.
const EditorPane = lazy(() =>
  import("@/components/EditorPane").then((m) => ({ default: m.EditorPane }))
);
import { cn } from "@/lib/utils";
import type { Session } from "@/types";
import type { Settings } from "@/lib/settings";

interface SessionPanesProps {
  sessions: Session[];
  activeId: string | null;
  settings: Settings;
  /** Chat sessions rename themselves once Claude titles the thread. */
  onTitled: (session: Session, title: string) => void;
}

/**
 * Every non-dev session, mounted at once and revealed by tab. Panes stay
 * mounted so a pre-warmed project keeps booting in the background and switching
 * tabs never restarts a process (dev servers live in the Dev panel instead).
 */
export function SessionPanes({
  sessions,
  activeId,
  settings,
  onTitled,
}: SessionPanesProps) {
  return (
    <>
      {sessions
        .filter((s) => s.kind !== "dev")
        .map((s) => (
          <div
            key={s.id}
            className={cn("absolute inset-1", s.id === activeId ? "" : "hidden")}
          >
            {s.kind === "chat" ? (
              <ChatPane
                sessionId={s.id}
                cwd={s.cwd}
                resume={s.resume}
                active={s.id === activeId}
                fontFamily={settings.fontFamily}
                fontSize={settings.fontSize}
                skipPermissions={settings.dangerouslySkipPermissions}
                onTitled={(title) => onTitled(s, title)}
              />
            ) : s.kind === "editor" ? (
              <Suspense fallback={null}>
                <EditorPane
                  projectPath={s.cwd}
                  fontFamily={settings.editorFontFamily}
                  fontSize={settings.editorFontSize}
                  active={s.id === activeId}
                />
              </Suspense>
            ) : s.kind === "dokploy-logs" ? (
              <DokployLogsPane
                sessionId={s.id}
                url={settings.dokployUrl}
                apiKey={settings.dokployApiKey}
                service={s.dokployLog!}
                active={s.id === activeId}
                fontFamily={settings.fontFamily}
                fontSize={settings.fontSize}
              />
            ) : (
              <TerminalPane
                sessionId={s.id}
                cwd={s.cwd}
                command={s.command}
                persistKey={s.persistKey}
                fontFamily={settings.fontFamily}
                fontSize={settings.fontSize}
                scrollback={settings.scrollback}
                active={s.id === activeId}
              />
            )}
          </div>
        ))}
    </>
  );
}
