import { useState } from "react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useProviderStatus,
  useSkillAdd,
  useSkillCopy,
  useSkillRemove,
  useSkills,
} from "@/lib/queries";
import {
  missingFrom,
  readersOf,
  type SkillInfo,
  type SkillSource,
} from "@/lib/skills";
import {
  MCP_HARNESS_LABEL,
  MCP_HARNESS_ORDER,
  type McpHarness,
} from "@/lib/mcp";
import { SkillsAddDialog } from "@/components/SkillsAddDialog";
import { Group } from "@/components/SettingsFields";

/** Settings → Skills: every skill folder across the harness skill homes,
 *  merged by name. Folders are shared surfaces — `~/.claude/skills` is read
 *  by four harnesses — so chips reflect real readers, and deleting one folder
 *  warns about everyone it serves. */
export function SkillsSection() {
  const skills = useSkills();
  const providers = useProviderStatus().data ?? [];
  const addSkill = useSkillAdd();
  const copySkill = useSkillCopy();
  const removeSkill = useSkillRemove();
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    skill: SkillInfo;
    source: SkillSource;
  } | null>(null);

  const installed = new Set(
    providers.filter((p) => p.installed).map((p) => p.id)
  );

  const list = skills.data ?? [];
  const copies = list.reduce((sum, s) => sum + s.sources.length, 0);

  const mutationError =
    addSkill.error ?? copySkill.error ?? removeSkill.error;
  const mutationErrorText =
    mutationError instanceof Error
      ? mutationError.message
      : mutationError
        ? String(mutationError)
        : null;

  return (
    <>
      <Group
        title="Skills"
        hint="Merged from each harness's skill folder. The shared ones (~/.claude/skills, ~/.agents/skills) are read by several harnesses — one folder, every reader listed."
      >
        {list.length > 0 ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground tabular-nums">
                {list.length} skill{list.length === 1 ? "" : "s"} · {copies}{" "}
                {copies === 1 ? "copy" : "copies"}
              </p>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="size-3.5" />
                Create a skill
              </Button>
            </div>

            <div className="grid gap-1.5">
              {list.map((skill) => {
                const open = expanded === skill.name;
                const readers = readersOf(skill);
                const absent = missingFrom(skill);
                return (
                  <div
                    key={skill.name}
                    className="surface-raised rounded-lg border bg-card/40 transition-colors hover:border-foreground/15"
                  >
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : skill.name)}
                      className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left"
                    >
                      <span className="grid min-w-0 gap-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {skill.name}
                          {skill.differs && (
                            <span className="flex items-center gap-1.5 text-xs font-normal text-amber-600 dark:text-amber-500">
                              <span className="size-1.5 rounded-full bg-amber-500/80" />
                              copies differ
                            </span>
                          )}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {skill.description || "No description"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {MCP_HARNESS_ORDER.map((harness) => (
                          <HarnessChip
                            key={harness}
                            harness={harness}
                            connected={readers.includes(harness)}
                          />
                        ))}
                        <ChevronDown
                          className={cn(
                            "size-4 text-muted-foreground transition-transform duration-200",
                            open && "rotate-180"
                          )}
                        />
                      </span>
                    </button>

                    {open && (
                      <div className="grid gap-1.5 rounded-b-lg border-t bg-canvas/50 px-3 py-3 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                        {skill.sources.map((source) => (
                          <div
                            key={source.skillDir}
                            className="flex items-center justify-between gap-3 text-sm"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="flex shrink-0 items-center -space-x-1">
                                {source.harnesses.map((harness) => (
                                  <img
                                    key={harness}
                                    src={`/provider-icons/${harness}.svg`}
                                    alt={MCP_HARNESS_LABEL[harness]}
                                    title={MCP_HARNESS_LABEL[harness]}
                                    className="size-4 rounded-full bg-card object-contain"
                                  />
                                ))}
                              </span>
                              <code className="truncate text-xs text-muted-foreground">
                                {source.skillDir}
                              </code>
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="shrink-0 text-destructive hover:text-destructive"
                              onClick={() =>
                                setPendingRemove({ skill, source })
                              }
                            >
                              Delete
                            </Button>
                          </div>
                        ))}
                        {absent.length > 0 && (
                          <div className="flex items-center justify-between gap-3 pt-1.5">
                            <span className="text-sm text-muted-foreground">
                              Copy to
                            </span>
                            <span className="flex flex-wrap justify-end gap-1.5">
                              {absent.map((harness) => (
                                <button
                                  key={harness}
                                  type="button"
                                  title={
                                    installed.has(harness)
                                      ? undefined
                                      : `${MCP_HARNESS_LABEL[harness]} isn't installed`
                                  }
                                  onClick={() =>
                                    copySkill.mutate({
                                      skillDir: skill.sources[0].skillDir,
                                      harness,
                                    })
                                  }
                                  className="flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                                >
                                  <Plus className="size-3" />
                                  <img
                                    src={`/provider-icons/${harness}.svg`}
                                    alt=""
                                    className="size-3.5 object-contain"
                                  />
                                  {MCP_HARNESS_LABEL[harness]}
                                </button>
                              ))}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : skills.isPending ? (
          <div className="grid gap-1.5" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-12 animate-pulse rounded-lg bg-secondary/40"
              />
            ))}
          </div>
        ) : skills.isError ? (
          <p className="text-sm text-destructive">
            Couldn't read skill folders: {errorText(skills.error)}
          </p>
        ) : (
          <div className="grid place-items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Sparkles className="size-4" />
            </span>
            <div className="grid gap-1">
              <p className="text-sm font-medium">No skills installed</p>
              <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                Skills are reusable instruction folders your agents load when a
                task matches. Create one, and copy it to more harnesses later.
              </p>
            </div>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-3.5" />
              Create a skill
            </Button>
          </div>
        )}

        {mutationErrorText && (
          <p className="text-xs text-destructive">{mutationErrorText}</p>
        )}
      </Group>

      <SkillsAddDialog open={addOpen} onOpenChange={setAddOpen} />

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(o) => !o && setPendingRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete{" "}
              {pendingRemove
                ? folderName(pendingRemove.source.skillDir)
                : ""}{" "}
              ?
            </DialogTitle>
            <DialogDescription>
              {pendingRemove && pendingRemove.source.harnesses.length > 1 ? (
                <>
                  This folder is also read by{" "}
                  {pendingRemove.source.harnesses
                    .map((harness) => MCP_HARNESS_LABEL[harness])
                    .join(", ")}{" "}
                  — deleting it removes the skill for all of them.{" "}
                </>
              ) : null}
              The whole folder goes, including any scripts and references.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingRemove(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingRemove) {
                  removeSkill.mutate(pendingRemove.source.skillDir);
                  setPendingRemove(null);
                }
              }}
            >
              Delete folder
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HarnessChip({
  harness,
  connected,
}: {
  harness: McpHarness;
  connected: boolean;
}) {
  const label = MCP_HARNESS_LABEL[harness];
  return (
    <span
      title={connected ? `${label}: reads this skill` : `${label}: not configured`}
      className={cn(
        "grid size-6 place-items-center rounded-full",
        connected ? "bg-secondary/70" : "border border-dashed"
      )}
    >
      <img
        src={`/provider-icons/${harness}.svg`}
        alt=""
        className={cn("size-3.5 object-contain", !connected && "opacity-35")}
      />
    </span>
  );
}

const folderName = (skillDir: string): string =>
  skillDir.split("/").filter(Boolean).pop() ?? skillDir;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
