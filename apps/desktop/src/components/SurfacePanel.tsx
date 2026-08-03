import { useEffect, useState } from "react";
import { ArrowLeft, FileDiff, Files, SquareTerminal } from "lucide-react";
import { SidePanel } from "@/components/SidePanel";
import { TerminalPane } from "@/components/TerminalPane";
import { EditorPane } from "@/components/EditorPane";
import { ChangesPanel } from "@/components/ChangesPanel";
import { cn } from "@/lib/utils";

/** Surfaces wired today. Browser is shown in the picker but disabled until it's
 *  built. */
type Surface = "terminal" | "files" | "diff";

const CARDS = [
  { key: "terminal", icon: SquareTerminal, title: "Terminal", desc: "Start a shell in this workspace.", enabled: true },
  { key: "files", icon: Files, title: "Files", desc: "Browse and read workspace files.", enabled: true },
  { key: "diff", icon: FileDiff, title: "Diff", desc: "Review, stage and commit changes.", enabled: true },
] as const;

const SURFACE_LABEL: Record<Surface, string> = {
  terminal: "Terminal",
  files: "Files",
  diff: "Diff",
};

interface SurfacePanelProps {
  projectPath: string;
  /** Hidden rather than unmounted when false — the shells inside keep running. */
  open: boolean;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  onClose: () => void;
  /** Git diff surface deps — same as the standalone Changes panel. */
  sessionIds: string[];
  openRouterApiKey: string;
  openRouterModel: string;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (
    worktreePath: string,
    repoRoot: string
  ) => void | Promise<void>;
}

/** The right panel's empty-state picker plus the surface it opens. Additive:
 *  it hosts a fresh shell, the file browser, or the git diff without touching
 *  the existing standalone panels. */
export default function SurfacePanel({
  projectPath,
  open,
  fontFamily,
  fontSize,
  scrollback,
  onClose,
  sessionIds,
  openRouterApiKey,
  openRouterModel,
  onOpenWorktree,
  onRemoveWorktree,
}: SurfacePanelProps) {
  const [surface, setSurface] = useState<Surface | null>(null);
  // Every project whose terminal has been opened. Their panes stay mounted for
  // the app's lifetime, so leaving the surface — or the project — never kills
  // the shell or whatever it's running.
  const [termProjects, setTermProjects] = useState<string[]>([]);

  useEffect(() => {
    if (surface !== "terminal") return;
    setTermProjects((p) => (p.includes(projectPath) ? p : [...p, projectPath]));
  }, [surface, projectPath]);

  const header = surface ? (
    <button
      onClick={() => setSurface(null)}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      {SURFACE_LABEL[surface]}
    </button>
  ) : (
    <span className="pl-1 text-sm font-medium">Surfaces</span>
  );

  return (
    <SidePanel storageKey="surface" open={open} onClose={onClose} header={header}>
      {surface === null && (
        <div className="flex min-h-0 flex-1 animate-in fade-in duration-200">
          <Picker onPick={setSurface} />
        </div>
      )}

      {/* Terminals are never unmounted, only hidden — unmounting kills the PTY. */}
      {termProjects.map((path) => (
        <div
          key={path}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col",
            surface === "terminal" && path === projectPath ? "" : "hidden"
          )}
        >
          <TerminalPane
            sessionId={`surface-term:${path}`}
            cwd={path}
            fontFamily={fontFamily}
            fontSize={fontSize}
            scrollback={scrollback}
            active={open && surface === "terminal" && path === projectPath}
          />
        </div>
      ))}

      {open && surface === "files" && (
        <div
          key={projectPath}
          className="relative flex min-h-0 flex-1 animate-in flex-col fade-in duration-200"
        >
          <EditorPane
            projectPath={projectPath}
            fontFamily={fontFamily}
            fontSize={fontSize}
            active
          />
        </div>
      )}

      {open && surface === "diff" && (
        <div
          key={projectPath}
          className="relative flex min-h-0 flex-1 animate-in flex-col fade-in duration-200"
        >
          <ChangesPanel
            embedded
            projectPath={projectPath}
            sessionIds={sessionIds}
            openRouterApiKey={openRouterApiKey}
            openRouterModel={openRouterModel}
            onClose={() => setSurface(null)}
            onOpenWorktree={onOpenWorktree}
            onRemoveWorktree={onRemoveWorktree}
          />
        </div>
      )}
    </SidePanel>
  );
}

/** The 2×2 card grid shown when no surface is open. */
function Picker({ onPick }: { onPick: (s: Surface) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-4">
      <h2 className="text-sm font-semibold text-foreground">Open a surface</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose what to show in the right panel.
      </p>
      <div className="mt-5 grid w-full grid-cols-2 gap-2.5">
        {CARDS.map((c) => (
          <button
            key={c.key}
            type="button"
            disabled={!c.enabled}
            onClick={() => onPick(c.key as Surface)}
            className={cn(
              "flex flex-col gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-left transition duration-150",
              c.enabled
                ? "hover:-translate-y-0.5 hover:border-border/80 hover:bg-secondary/70 active:translate-y-0 active:scale-95"
                : "cursor-not-allowed opacity-40"
            )}
          >
            <c.icon className="size-5 text-foreground" />
            <div>
              <div className="text-sm font-medium text-foreground">{c.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{c.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
