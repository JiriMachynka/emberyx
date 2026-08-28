import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FORGE_LABEL } from "@/lib/forge";
import {
  cloneDirectoryName,
  joinCloneDest,
  parseCloneInput,
  type CloneSource,
} from "@/lib/clone";

interface CloneDialogProps {
  open: boolean;
  source: CloneSource | null;
  onOpenChange: (open: boolean) => void;
  onCloned: (path: string) => void;
}

const PLACEHOLDER: Record<CloneSource, string> = {
  github: "owner/repo",
  gitlab: "group/project",
  url: "https://github.com/owner/repo.git",
};

const TITLE: Record<CloneSource, string> = {
  github: "Clone a GitHub repository",
  gitlab: "Clone a GitLab repository",
  url: "Clone from a Git URL",
};

const HINT: Record<CloneSource, string> = {
  github: "owner/repo, or a GitHub URL.",
  gitlab: "group/project, or a GitLab URL.",
  url: "HTTPS, SSH, or any git clone URL.",
};

/** Collect the repo and destination, clone, then open the new folder. */
export function CloneDialog({ open, source, onOpenChange, onCloned }: CloneDialogProps) {
  const [input, setInput] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput("");
    setBusy(false);
    setError(null);
    void homeDir().then((dir) => setParent(dir));
  }, [open, source]);

  const target = source ? parseCloneInput(input, source) : null;
  const folder = cloneDirectoryName(input);
  const destination = parent && folder ? joinCloneDest(parent, folder) : "";
  const canClone = target !== null && destination !== "" && !busy;

  const pickParent = async () => {
    const selected = await pickDirectory({
      directory: true,
      multiple: false,
      defaultPath: parent || undefined,
      title: "Clone into",
    });
    if (typeof selected === "string") setParent(selected);
  };

  const clone = async () => {
    if (!target || !destination) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        target.kind === "url"
          ? await invoke<string>("git_clone", { url: target.url, destination })
          : await invoke<string>("forge_clone", {
              provider: target.kind,
              repository: target.repository,
              destination,
            });
      onOpenChange(false);
      onCloned(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{source ? TITLE[source] : "Clone"}</DialogTitle>
          <DialogDescription>{source ? HINT[source] : ""}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-medium">
              {source === "url" ? "Git URL" : "Repository"}
            </span>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={source ? PLACEHOLDER[source] : ""}
              spellCheck={false}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && canClone) void clone();
              }}
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Clone into</span>
            <div className="flex gap-2">
              <Input value={parent} readOnly spellCheck={false} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={() => void pickParent()}>
                Choose
              </Button>
            </div>
            {destination && (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {destination}
              </span>
            )}
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void clone()} disabled={!canClone}>
            {busy
              ? "Cloning…"
              : source && source !== "url"
                ? `Clone from ${FORGE_LABEL[source]}`
                : "Clone"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
