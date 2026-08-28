import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useProviderStatus, useSkillAdd } from "@/lib/queries";
import { isValidSkillName } from "@/lib/skills";
import {
  MCP_HARNESS_LABEL,
  MCP_HARNESS_ORDER,
  type McpHarness,
} from "@/lib/mcp";

interface SkillsAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Create a skill: one SKILL.md, written into each selected harness's own
 *  skill folder. Form state follows the ActionDialog pattern — local state,
 *  reseeded whenever the dialog opens. */
export function SkillsAddDialog({ open, onOpenChange }: SkillsAddDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [targets, setTargets] = useState<McpHarness[]>(["claude"]);
  const providers = useProviderStatus().data ?? [];
  const addSkill = useSkillAdd();

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setBody("");
    setTargets(["claude"]);
  }, [open]);

  const installed = new Set(
    providers.filter((p) => p.installed).map((p) => p.id)
  );

  const nameError =
    name.trim() !== "" && !isValidSkillName(name.trim())
      ? "Letters, digits, - and _ only — the name becomes a folder."
      : null;
  const canCreate =
    isValidSkillName(name.trim()) &&
    description.trim() !== "" &&
    targets.length > 0;

  const create = () => {
    if (!canCreate) return;
    addSkill.mutate(
      {
        name: name.trim(),
        description: description.trim(),
        body,
        harnesses: targets,
      },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  const mutationError = addSkill.error;
  const errorText =
    mutationError instanceof Error
      ? mutationError.message
      : mutationError
        ? String(mutationError)
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a skill</DialogTitle>
          <DialogDescription>
            Written as a SKILL.md folder into each selected harness's skill
            folder. A copy can be added to more harnesses later from the list.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="review-diff"
              spellCheck={false}
              autoFocus
            />
            {nameError && (
              <span className="text-xs text-destructive">{nameError}</span>
            )}
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Description</span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Review a diff and leave line-level comments"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              What it does and when the agent should reach for it.
            </span>
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Instructions</span>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Steps the agent follows when the skill runs…"
              rows={8}
              spellCheck={false}
              className="resize-none font-mono text-sm"
            />
          </label>

          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Create for</span>
            <div className="flex flex-wrap gap-1.5">
              {MCP_HARNESS_ORDER.map((harness) => {
                const selected = targets.includes(harness);
                const isInstalled = installed.has(harness);
                return (
                  <button
                    key={harness}
                    type="button"
                    title={
                      isInstalled
                        ? undefined
                        : `${MCP_HARNESS_LABEL[harness]} isn't installed — the folder is written anyway`
                    }
                    onClick={() =>
                      setTargets((prev) =>
                        prev.includes(harness)
                          ? prev.filter((t) => t !== harness)
                          : [...prev, harness]
                      )
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      selected
                        ? "border-foreground/30 bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        selected
                          ? isInstalled
                            ? "bg-emerald-500"
                            : "bg-amber-500"
                          : "bg-muted-foreground/30"
                      )}
                    />
                    <img
                      src={`/provider-icons/${harness}.svg`}
                      alt=""
                      className="size-3.5 object-contain"
                    />
                    {MCP_HARNESS_LABEL[harness]}
                  </button>
                );
              })}
            </div>
          </div>

          {errorText && <p className="text-xs text-destructive">{errorText}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={create}
            disabled={!canCreate || addSkill.isPending}
          >
            {addSkill.isPending ? "Creating…" : "Create skill"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
