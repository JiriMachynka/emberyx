import { lazy, Suspense } from "react";
import { TerminalPane } from "@/components/TerminalPane";
import { ChatPane } from "@/components/ChatPane";
import { DokployLogsPane } from "@/components/DokployLogsPane";
import { ProjectSettingsPane } from "@/components/ProjectSettingsPane";
// CodeMirror is a big chunk; only sessions that open the editor pay for it.
const EditorPane = lazy(() =>
  import("@/components/EditorPane").then((m) => ({ default: m.EditorPane }))
);
import { cn } from "@/lib/utils";
import type { Project, Session } from "@/types";
import type { Settings } from "@/lib/settings";

/** Everything the per-project settings pane needs to read and write config. */
export interface ProjectSettingsActions {
  devCommand: string;
  onSetDevCommand: (command: string) => void;
  onRefreshDokploy: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (
    worktreePath: string,
    repoRoot: string
  ) => void | Promise<void>;
}

interface SessionPanesProps {
  sessions: Session[];
  projects: Project[];
  activeId: string | null;
  settings: Settings;
  /** Chat sessions rename themselves once Claude titles the thread. */
  onTitled: (session: Session, title: string) => void;
  projectSettings: ProjectSettingsActions;
}

function renderSettings(
  session: Session,
  projects: Project[],
  activeId: string | null,
  settings: Settings,
  actions: ProjectSettingsActions
) {
  const project = projects.find((p) => p.id === session.projectId);
  if (!project || session.id !== activeId) return null;
  return (
    <ProjectSettingsPane
      project={project}
      active
      devCommand={actions.devCommand}
      onSetDevCommand={actions.onSetDevCommand}
      onRefreshDokploy={actions.onRefreshDokploy}
      onOpenWorktree={actions.onOpenWorktree}
      onRemoveWorktree={actions.onRemoveWorktree}
      dokployConfigured={Boolean(settings.dokployUrl && settings.dokployApiKey)}
    />
  );
}

/**
 * Every non-dev session, mounted at once and revealed by tab. Panes stay
 * mounted so a pre-warmed project keeps booting in the background and switching
 * tabs never restarts a process (dev servers live in the Dev panel instead).
 */
export function SessionPanes({
  sessions,
  projects,
  activeId,
  settings,
  onTitled,
  projectSettings,
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
            ) : s.kind === "settings" ? (
              // The config handlers are bound to the *active* project, so this
              // pane only renders while it is the focused tab. Nothing here
              // needs to keep running in the background.
              renderSettings(s, projects, activeId, settings, projectSettings)
            ) : s.kind === "agent" || s.kind === "dev" ? (
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
            ) : null}
          </div>
        ))}
    </>
  );
}
