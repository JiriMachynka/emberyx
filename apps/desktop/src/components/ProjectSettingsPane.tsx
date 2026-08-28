import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/SettingsFields";
import {
  AGENT_BACKENDS,
  BACKEND_LABEL,
  isAgentBackend,
  type AgentBackend,
} from "@/lib/agentBackend";
import { basename } from "@/lib/path";
import type { Project } from "@/types";

interface ProjectSettingsPaneProps {
  project: Project;
  /** Backend pinned to this project; unset follows the global default. */
  backend: AgentBackend | undefined;
  onSetBackend: (backend: AgentBackend | null) => void;
  /** Global default, shown as the "follow" option's label. */
  defaultBackend: AgentBackend;
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
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (
    worktreePath: string,
    repoRoot: string
  ) => void | Promise<void>;
}

/** Per-project configuration collected in one place: the dev command and the
 *  git worktree this project sits in. Reads only what the caller already
 *  holds — no fetching on mount. */
/** Sentinel for "no pin" — Radix Select can't hold an empty string value. */
const FOLLOW_DEFAULT = "default";

export function ProjectSettingsPane({
  project,
  backend,
  onSetBackend,
  defaultBackend,
  devCommand,
  onSetDevCommand,
  buildCommand,
  onSetBuildCommand,
  detectedBuildCommand,
  startCommand,
  onSetStartCommand,
  detectedStartCommand,
  onOpenWorktree,
  onRemoveWorktree,
}: ProjectSettingsPaneProps) {
  const [draft, setDraft] = useState(devCommand);
  const [buildDraft, setBuildDraft] = useState(buildCommand);
  const [startDraft, setStartDraft] = useState(startCommand);
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
        <div className="text-sm font-semibold">Agent</div>
        <Field label="Backend">
          <Select
            value={backend ?? FOLLOW_DEFAULT}
            onValueChange={(v) => onSetBackend(isAgentBackend(v) ? v : null)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_DEFAULT}>
                Default ({BACKEND_LABEL[defaultBackend]})
              </SelectItem>
              {AGENT_BACKENDS.map((b) => (
                <SelectItem key={b} value={b}>
                  {BACKEND_LABEL[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </section>

      <section className="grid gap-3 border-t pt-4">
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
