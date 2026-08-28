import { useCallback, useRef } from "react";
import { ChatPane } from "@/components/ChatPane";
import { useAgentStore } from "@/lib/agentStore";
import { paneShouldMount } from "@/lib/paneMount";
import { cn } from "@/lib/utils";
import type { Project, Session } from "@/types";
import type { Settings } from "@/lib/settings";

interface SessionPanesProps {
  sessions: Session[];
  activeId: string | null;
  settings: Settings;
  /** Persist a new default `--model` when a chat pane switches models. */
  onModelChange: (model: string) => void;
  /** Persist a new default reasoning effort when a chat pane switches it. */
  onEffortChange: (effort: string) => void;
  projects: Project[];
  recentProjects: string[];
  onSelectProject: (projectId: string) => void;
  onOpenProject: (path: string) => void;
  /** Chat sessions rename themselves once Claude titles the thread. */
  onTitled: (session: Session, title: string) => void;
}

/**
 * Non-dev sessions, mounted when focused or still mid-turn. A settled hidden
 * pane remounts from a windowed transcript; keeping it alive would parse and
 * hold every project's chat at once. A working/waiting pane stays mounted
 * (hidden) so unmount cannot kill the process or drop an approval prompt.
 * Dev servers live in the Dev panel instead.
 */
export function SessionPanes({
  sessions,
  activeId,
  settings,
  onModelChange,
  onEffortChange,
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
  onTitled,
}: SessionPanesProps) {
  const statuses = useAgentStore((s) => s.statuses);
  return (
    <>
      {sessions
        .filter((s) => s.kind !== "dev")
        .filter((s) => paneShouldMount(s.id, activeId, statuses[s.id]))
        .map((s) => (
          <SessionPaneRow
            key={s.id}
            session={s}
            activeId={activeId}
            settings={settings}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
            projects={projects}
            recentProjects={recentProjects}
            onSelectProject={onSelectProject}
            onOpenProject={onOpenProject}
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
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
  onTitled,
}: {
  session: Session;
  activeId: string | null;
  settings: Settings;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  projects: Project[];
  recentProjects: string[];
  onSelectProject: (projectId: string) => void;
  onOpenProject: (path: string) => void;
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
          providerLaunch={settings.providerLaunch}
          claudeProfiles={settings.claudeProfiles}
          codexSandbox={settings.codexSandbox}
          projects={projects}
          recentProjects={recentProjects}
          onSelectProject={onSelectProject}
          onOpenProject={onOpenProject}
          onTitled={handleTitled}
        />
      ) : null}
    </div>
  );
}
