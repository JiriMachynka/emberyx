import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FORGE_LABEL, isRemoteHost, type RemoteHost } from "@/lib/forge";
import { basename } from "@/lib/path";
import { useForgeCliStatus, useInvalidateGit } from "@/lib/queries";

interface PublishDialogProps {
  open: boolean;
  projectPath: string | null;
  onOpenChange: (open: boolean) => void;
}

interface PublishResult {
  url: string;
  remote: string;
  pushed: boolean;
  message: string;
}

/** Create a GitHub/GitLab repo from the current folder, add origin, push if HEAD exists. */
export function PublishDialog({ open, projectPath, onOpenChange }: PublishDialogProps) {
  const clis = useForgeCliStatus().data ?? [];
  const invalidateGit = useInvalidateGit();
  const ready = clis.filter((cli) => cli.authenticated).map((cli) => cli.id);
  const [provider, setProvider] = useState<RemoteHost>("github");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setVisibility("private");
    setName(projectPath ? basename(projectPath) : "");
  }, [open, projectPath]);

  useEffect(() => {
    if (!open) return;
    if (ready.includes(provider)) return;
    if (ready[0]) setProvider(ready[0]);
  }, [open, provider, ready]);

  const canPublish =
    projectPath !== null && name.trim() !== "" && ready.includes(provider) && !busy;

  const publish = async () => {
    if (!projectPath) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<PublishResult>("forge_publish", {
        path: projectPath,
        provider,
        name: name.trim(),
        visibility,
      });
      invalidateGit(projectPath);
      onOpenChange(false);
      toast.success("Published", { description: result.message });
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
          <DialogTitle>Publish repository</DialogTitle>
          <DialogDescription>
            Creates a remote with gh or glab, adds origin, and pushes if this
            repo has commits.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {ready.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Log in with gh auth login or glab auth login, then check Settings
              → Source Control.
            </p>
          ) : (
            <>
              {ready.length > 1 && (
                <label className="grid gap-1.5">
                  <span className="text-sm font-medium">Host</span>
                  <Select
                    value={provider}
                    onValueChange={(v) => {
                      if (isRemoteHost(v)) setProvider(v);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ready.map((id) => (
                        <SelectItem key={id} value={id}>
                          {FORGE_LABEL[id]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}

              <label className="grid gap-1.5">
                <span className="text-sm font-medium">Name</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={ready[0] === "gitlab" ? "group/project" : "owner/repo"}
                  spellCheck={false}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canPublish) void publish();
                  }}
                />
              </label>

              <label className="grid gap-1.5">
                <span className="text-sm font-medium">Visibility</span>
                <Select
                  value={visibility}
                  onValueChange={(v) => {
                    if (v === "private" || v === "public") setVisibility(v);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void publish()} disabled={!canPublish}>
            {busy ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
