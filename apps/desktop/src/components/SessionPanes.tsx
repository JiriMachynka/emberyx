import { useCallback, useRef } from "react";
import { ChatPane } from "@/components/ChatPane";
import { DokployLogsPane } from "@/components/DokployLogsPane";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";
import type { Settings } from "@/lib/settings";

interface SessionPanesProps {
  sessions: Session[];
  activeId: string | null;
  settings: Settings;
  /** Persist a new default `--model` when a chat pane switches models. */
  onModelChange: (model: string) => void;
  /** Persist a new default reasoning effort when a chat pane switches it. */
  onEffortChange: (effort: string) => void;
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
  onModelChange,
  onEffortChange,
  onTitled,
}: SessionPanesProps) {
  return (
    <>
      {sessions
        .filter((s) => s.kind !== "dev")
        .map((s) => (
          <SessionPaneRow
            key={s.id}
            session={s}
            activeId={activeId}
            settings={settings}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
            onTitled={onTitled}
          />
        ))}
    </>
  );
}

/** One mounted pane. Extracted so its per-session `onTitled` can be stabilized
 *  with `useCallback` (a hook can't run inside the `.map` above) — without it a
 *  fresh closure each render would defeat ChatPane's memo. */
function SessionPaneRow({
  session,
  activeId,
  settings,
  onModelChange,
  onEffortChange,
  onTitled,
}: {
  session: Session;
  activeId: string | null;
  settings: Settings;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onTitled: (session: Session, title: string) => void;
}) {
  const active = session.id === activeId;
  // `session` is a new object whenever the workspace list rebuilds. Pin the
  // callback on `onTitled` alone or ChatPane's memo sees a new prop every poll.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const handleTitled = useCallback(
    (title: string) => onTitled(sessionRef.current, title),
    [onTitled]
  );
  return (
    <div className={cn("absolute inset-0", active ? "" : "hidden")}>
      {session.kind === "chat" ? (
        <ChatPane
          sessionId={session.id}
          cwd={session.cwd}
          resume={session.resume}
          backend={session.backend ?? "claude"}
          active={active}
          fontFamily={settings.chatFontFamily}
          fontSize={settings.fontSize}
          skipPermissions={settings.dangerouslySkipPermissions}
          persistent={settings.persistentAgents}
          permissionMode={settings.permissionMode}
          model={settings.model}
          onModelChange={onModelChange}
          effort={settings.effort}
          onEffortChange={onEffortChange}
          onTitled={handleTitled}
        />
      ) : session.kind === "dokploy-logs" ? (
        <DokployLogsPane
          sessionId={session.id}
          url={settings.dokployUrl}
          apiKey={settings.dokployApiKey}
          service={session.dokployLog!}
          active={active}
          fontFamily={settings.fontFamily}
          fontSize={settings.fontSize}
        />
      ) : null}
    </div>
  );
}
