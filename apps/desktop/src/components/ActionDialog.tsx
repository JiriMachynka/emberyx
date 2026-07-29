import { useEffect, useState } from "react";
import { Play, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { newActionId, type ProjectAction } from "@/lib/actions";

interface ActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action being edited, or null to add a new one. */
  action: ProjectAction | null;
  onSave: (action: ProjectAction) => void;
  onDelete?: (id: string) => void;
}

export function ActionDialog({
  open,
  onOpenChange,
  action,
  onSave,
  onDelete,
}: ActionDialogProps) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [openPreviewOnRun, setOpenPreviewOnRun] = useState(false);

  // Seed the form whenever the dialog opens (or the edited action changes).
  useEffect(() => {
    if (!open) return;
    setName(action?.name ?? "");
    setCommand(action?.command ?? "");
    setPreviewUrl(action?.previewUrl ?? "");
    setRunOnWorktreeCreate(action?.runOnWorktreeCreate ?? false);
    setOpenPreviewOnRun(action?.openPreviewOnRun ?? false);
  }, [open, action]);

  const canSave = name.trim() !== "" && command.trim() !== "";

  const save = () => {
    if (!canSave) return;
    onSave({
      id: action?.id ?? newActionId(),
      name: name.trim(),
      command: command.trim(),
      previewUrl: previewUrl.trim() || undefined,
      runOnWorktreeCreate,
      openPreviewOnRun,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action ? "Edit action" : "Add action"}</DialogTitle>
          <DialogDescription>
            Actions are project-scoped commands you can run from the top bar or
            keybindings.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <div className="flex items-center gap-2">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
                <Play className="size-4" />
              </span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Test"
                spellCheck={false}
                autoFocus
              />
            </div>
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Keybinding</span>
            <Input placeholder="Press shortcut" disabled />
            <span className="text-xs text-muted-foreground">
              Per-action shortcuts are coming soon.
            </span>
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Command</span>
            <Textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="bun test"
              spellCheck={false}
              rows={3}
              className="resize-none font-mono text-sm"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Preview URL (optional)</span>
            <Input
              value={previewUrl}
              onChange={(e) => setPreviewUrl(e.target.value)}
              placeholder="http://localhost:5173"
              spellCheck={false}
              disabled
            />
            <span className="text-xs text-muted-foreground">
              Opens in the in-app preview when this action runs. Coming soon.
            </span>
          </label>

          <SwitchRow
            checked={runOnWorktreeCreate}
            onChange={setRunOnWorktreeCreate}
          >
            Run automatically on worktree creation
          </SwitchRow>

          <SwitchRow checked={openPreviewOnRun} onChange={setOpenPreviewOnRun} disabled>
            Open preview automatically when this action runs
          </SwitchRow>
        </div>

        <div className="flex items-center justify-between pt-2">
          {action && onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                onDelete(action.id);
                onOpenChange(false);
              }}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!canSave}>
              Save action
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled toggle switch matching the reference design. */
function SwitchRow({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-lg border border-border bg-secondary/40 px-3 py-2.5",
        disabled && "opacity-50"
      )}
    >
      <span className="text-sm">{children}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
