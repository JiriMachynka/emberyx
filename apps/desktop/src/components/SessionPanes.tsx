import { Profiler, useCallback, useMemo, useRef } from "react";
import { onRender } from "@/lib/perf";
import { ChatPane } from "@/components/ChatPane";
import { PaneErrorBoundary } from "@/components/PaneErrorBoundary";
import { useAgentStore } from "@/lib/agentStore";
import { paneShouldMount, pushRecent } from "@/lib/paneMount";
import { statusOf } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { AgentBackend } from "@/lib/agentBackend";
import type { Project, Session, SessionStatus } from "@/types";
import type { AccessLevel, Settings } from "@/lib/settings";

interface SessionPanesProps {
  sessions: Session[];
  activeId: string | null;
  settings: Settings;
  /** Persist a new default `--model` when a chat pane switches models. */
  onModelChange: (model: string) => void;
  /** Persist a new default backend when a chat pane's picker switches
   *  provider, so the stored model/backend pair stays coherent. */
  onBackendChange: (backend: AgentBackend) => void;
  /** Persist a new default reasoning effort when a chat pane switches it. */
  onEffortChange: (effort: string) => void;
  onAccessChange: (level: AccessLevel) => void;
  onJevAutoApproveChange: (v: boolean) => void;
  projects: Project[];
  recentProjects: string[];
  onSelectProject: (projectId: string) => void;
  onOpenProject: (path: string) => void;
  /** Chat sessions rename themselves once Claude titles the thread. */
  onTitled: (session: Session, title: string) => void;
  /** A fresh chat named its thread — list it before its transcript exists. */
  onThreadStarted: (session: Session, threadId: string, firstMessage: string) => void;
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void;
}

/**
 * Non-dev sessions, mounted when focused, still mid-turn, or recently visited.
 * A working/waiting pane stays mounted (hidden) so unmount cannot kill the
 * process or drop an approval prompt; the last few settled panes stay mounted
 * because remounting one respawns the CLI and re-renders its whole transcript
 * cold, which is the lag when switching back and forth. `PANE_KEEP_ALIVE`
 * bounds how many chats are held at once. Dev servers live in the Dev panel.
 */
export function SessionPanes({
  sessions,
  activeId,
  settings,
  onModelChange,
  onBackendChange,
  onEffortChange,
  onAccessChange,
  onJevAutoApproveChange,
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
  onTitled,
  onThreadStarted,
  onOpenWorktree,
}: SessionPanesProps) {
  const chats = useMemo(() => sessions.filter((s) => s.kind !== "dev"), [sessions]);
  // Only these sessions' statuses decide what stays mounted. Subscribing to the
  // whole map re-rendered every pane container on any session's transition, and
  // `setStatus` allocates a new map each time — so subscribe to the joined
  // list instead, which changes only when one of these actually moves.
  const statusKey = useAgentStore((s) =>
    chats.map((c) => statusOf(s.statuses, c.id)).join(",")
  );
  const statuses = useMemo(
    () => statusKey.split(",") as SessionStatus[],
    [statusKey]
  );
  // Recency is derived during render, not in an effect: an effect would run
  // after the new pane already mounted and the old one already unmounted,
  // which is the cost we are avoiding. `pushRecent` returns the same array
  // when nothing moved, so mutating the ref here is stable under StrictMode.
  const recentRef = useRef<string[]>([]);
  recentRef.current = pushRecent(recentRef.current, activeId);
  const recent = recentRef.current;
  return (
    <>
      {chats
        .filter((s, i) => paneShouldMount(s.id, activeId, statuses[i], recent))
        .map((s) => (
          <SessionPaneRow
            key={s.id}
            session={s}
            activeId={activeId}
             settings={settings}
             onModelChange={onModelChange}
             onBackendChange={onBackendChange}
             onEffortChange={onEffortChange}
            onAccessChange={onAccessChange}
            onJevAutoApproveChange={onJevAutoApproveChange}
            projects={projects}
            recentProjects={recentProjects}
            onSelectProject={onSelectProject}
            onOpenProject={onOpenProject}
            onTitled={onTitled}
            onThreadStarted={onThreadStarted}
            onOpenWorktree={onOpenWorktree}
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
  onBackendChange,
  onEffortChange,
  onAccessChange,
  onJevAutoApproveChange,
  projects,
  recentProjects,
  onSelectProject,
  onOpenProject,
  onTitled,
  onThreadStarted,
  onOpenWorktree,
}: {
  session: Session;
  activeId: string | null;
  settings: Settings;
  onModelChange: (model: string) => void;
  onBackendChange: (backend: AgentBackend) => void;
  onEffortChange: (effort: string) => void;
  onAccessChange: (level: AccessLevel) => void;
  onJevAutoApproveChange: (v: boolean) => void;
  projects: Project[];
  recentProjects: string[];
  onSelectProject: (projectId: string) => void;
  onOpenProject: (path: string) => void;
  onTitled: (session: Session, title: string) => void;
  onThreadStarted: (session: Session, threadId: string, firstMessage: string) => void;
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void;
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
  const handleThreadStarted = useCallback(
    (threadId: string, firstMessage: string) =>
      onThreadStarted(sessionRef.current, threadId, firstMessage),
    [onThreadStarted]
  );
  return (
    <div className={cn("absolute inset-0", active ? "" : "hidden")}>
      {session.kind === "chat" ? (
        // Keyed on the session so one pane's crash never blanks its siblings,
        // and so re-keying resets a boundary that belonged to a closed session.
        <PaneErrorBoundary key={session.id} label="This chat">
        <Profiler id="ChatPane" onRender={onRender}>
        <ChatPane
          sessionId={session.id}
          cwd={session.cwd}
          resume={session.resume}
          imported={session.imported ?? false}
          backend={session.backend ?? "claude"}
          active={active}
          fontFamily={settings.chatFontFamily}
          fontSize={settings.fontSize}
          skipPermissions={settings.dangerouslySkipPermissions}
          persistent={settings.persistentAgents}
          permissionMode={settings.permissionMode}
           model={settings.model}
           onModelChange={onModelChange}
           onBackendChange={onBackendChange}
           effort={settings.effort}
          onEffortChange={onEffortChange}
          onAccessChange={onAccessChange}
          jevAutoApprove={settings.jevAutoApprove}
          onJevAutoApproveChange={onJevAutoApproveChange}
          providerLaunch={settings.providerLaunch}
          claudeProfiles={settings.claudeProfiles}
          codexSandbox={settings.codexSandbox}
          projects={projects}
          recentProjects={recentProjects}
          onSelectProject={onSelectProject}
          onOpenProject={onOpenProject}
          onTitled={handleTitled}
          onThreadStarted={handleThreadStarted}
          onOpenWorktree={onOpenWorktree}
        />
        </Profiler>
        </PaneErrorBoundary>
      ) : null}
    </div>
  );
}
