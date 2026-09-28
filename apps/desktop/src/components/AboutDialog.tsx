import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** App-menu Info: same mark and line as the empty window, plus the version. */
export function AboutDialog() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    const unlisten = listen("show-about", () => setOpen(true));
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void getVersion().then(setVersion).catch(() => {});
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xs gap-5 p-8 text-center">
        <img
          src="/emberyx.png"
          alt=""
          className="ember-glow mx-auto size-16 rounded-2xl outline outline-1 outline-white/10"
        />
        <DialogHeader className="items-center">
          <DialogTitle className="ember-text text-xl font-semibold tracking-tight">
            Emberyx
          </DialogTitle>
          <DialogDescription>
            Chat cockpit for Claude, Codex, OpenCode, and Grok.
          </DialogDescription>
        </DialogHeader>
        {version && (
          <p className="text-xs tabular-nums text-muted-foreground">{version}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
