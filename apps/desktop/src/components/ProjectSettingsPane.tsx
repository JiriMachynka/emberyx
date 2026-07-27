import { useState } from "react";
import { GitBranch, RotateCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/SettingsFields";
import { basename } from "@/lib/path";
import type { Project } from "@/types";

interface ProjectSettingsPaneProps {
  project: Project;
  /** Per-project custom dev command; overrides workspace detection when set. */
  devCommand: string;
  onSetDevCommand: (command: string) => void;
  /** Raw build-command override; blank falls back to the detected default. */
  buildCommand: string;
  onSetBuildCommand: (command: string) => void;
  /** Detected build command, shown as the input placeholder. */
  detectedBuildCommand: string;
  /** Raw start-command override; blank falls back to the detected default. */
  startCommand: string;
  onSetStartCommand: (command: string) => void;
  /** Detected start command, shown as the input placeholder. */
  detectedStartCommand: string;
  onRefreshDokploy: () => void;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (
    worktreePath: string,
    repoRoot: string
  ) => void | Promise<void>;
  /** Dokploy credentials are set globally; without them nothing can match. */
  dokployConfigured: boolean;
}

/** Per-project configuration collected in one place: the dev command, the
 *  matched Dokploy deployment, and the git worktree this project sits in.
 *  Reads only what the caller already holds — no fetching on mount. */
export function ProjectSettingsPane({
  project,
  devCommand,
  onSetDevCommand,
  buildCommand,
  onSetBuildCommand,
  detectedBuildCommand,
  startCommand,
  onSetStartCommand,
  detectedStartCommand,
  onRefreshDokploy,
  onOpenWorktree,
  onRemoveWorktree,
  dokployConfigured,
}: ProjectSettingsPaneProps) {
  const [draft, setDraft] = useState(devCommand);
  const [buildDraft, setBuildDraft] = useState(buildCommand);
  const [startDraft, setStartDraft] = useState(startCommand);
  const dokploy = project.dokploy;
  const worktree = project.worktree;

  const commit = () => {
    if (draft !== devCommand) onSetDevCommand(draft);
  };

  const commitBuild = () => {
    if (buildDraft !== buildCommand) onSetBuildCommand(buildDraft);
  };

  const commitStart = () => {
    if (startDraft !== startCommand) onSetStartCommand(startDraft);
  };

  return (
    <div className="grid min-h-0 flex-1 content-start gap-6 overflow-auto p-4">
      <section className="grid gap-3">
        <div className="text-sm font-semibold">Dev command</div>
        <Field
          label="Custom command"
          hint="Runs at the project root instead of the detected packages. Leave blank to fall back to workspace detection."
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            placeholder="e.g. turbo run dev --filter=web"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Build command"
          hint="Runs at the project root. Leave blank to fall back to the detected build script."
        >
          <Input
            value={buildDraft}
            onChange={(e) => setBuildDraft(e.target.value)}
            onBlur={commitBuild}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitBuild();
            }}
            placeholder={detectedBuildCommand || "e.g. bun run build"}
            spellCheck={false}
          />
        </Field>
        <Field
          label="Start built app command"
          hint="Runs the built app at the project root. Leave blank to fall back to the detected start script."
        >
          <Input
            value={startDraft}
            onChange={(e) => setStartDraft(e.target.value)}
            onBlur={commitStart}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitStart();
            }}
            placeholder={detectedStartCommand || "e.g. bun run start"}
            spellCheck={false}
          />
        </Field>
      </section>

      <section className="grid gap-3 border-t pt-4">
        <div className="flex items-center gap-2">
          <div className="flex-1 text-sm font-semibold">Dokploy</div>
          <Button variant="outline" size="sm" onClick={onRefreshDokploy}>
            <RotateCw className="size-3.5" />
            Refresh
          </Button>
        </div>
        {!dokployConfigured ? (
          <p className="text-xs text-muted-foreground">
            Set a Dokploy server URL and API key in global Settings →
            Integrations, then refresh to match this project by git remote.
          </p>
        ) : !dokploy ? (
          <p className="text-xs text-muted-foreground">
            No Dokploy project matched this repo's git remote.
          </p>
        ) : (
          <div className="grid gap-2">
            <div className="text-sm">
              <span className="font-medium">{dokploy.projectName}</span>
              <span className="text-muted-foreground">
                {" "}
                · matched via {dokploy.matchedService}
              </span>
            </div>
            <ul className="grid gap-1">
              {dokploy.services.map((s) => (
                <li
                  key={`${s.kind}:${s.name}`}
                  className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm"
                >
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.kind}
                  </span>
                  {s.status && (
                    <span className="rounded bg-secondary px-1 py-px text-xs text-muted-foreground">
                      {s.status}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="grid gap-3 border-t pt-4">
        <div className="text-sm font-semibold">Worktree</div>
        {worktree ? (
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-sm">
              <GitBranch className="size-4 shrink-0 opacity-70" />
              <span className="font-medium">{worktree.branch}</span>
              <span className="truncate text-xs text-muted-foreground">
                {project.path}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Main checkout: {basename(worktree.repoRoot)}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onOpenWorktree(
                    project.path,
                    worktree.repoRoot,
                    worktree.branch
                  )
                }
              >
                Open
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  void onRemoveWorktree(project.path, worktree.repoRoot)
                }
              >
                Remove worktree
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            This project is the main checkout, not a worktree.
          </p>
        )}
      </section>
    </div>
  );
}
