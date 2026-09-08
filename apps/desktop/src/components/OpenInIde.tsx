import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { SquareArrowOutUpRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IDE_ICON, IDE_LABEL, buildIdeCommand } from "@/lib/ide";
import { loadSettings } from "@/lib/settings";

/**
 * Hand the project to the configured external editor.
 *
 * Its own button in the top bar rather than the last item of the Run menu:
 * opening the repo in an editor is not one of the project's actions, and it is
 * used often enough that it should not cost a menu.
 *
 * Settings are read on click rather than held as a prop — a stale editor choice
 * would send the project to the wrong app. The label only needs the choice made
 * when the bar mounted, and `loadSettings` parses and migrates the whole blob,
 * so reading it in render would do that on every parent re-render.
 */
export function OpenInIde({ projectPath }: { projectPath: string }) {
  const [labelIde] = useState(() => loadSettings().ide);
  const label = `Open in ${IDE_LABEL[labelIde]}`;
  const icon = IDE_ICON[labelIde];
  const openInIde = async () => {
    const { ide, ideCustomCommand } = loadSettings();
    const command = buildIdeCommand(ide, { project: projectPath }, ideCustomCommand);
    if (!command) {
      toast.error("No editor configured", {
        description: "Set a custom command in Settings → Connections.",
      });
      return;
    }
    try {
      await invoke("open_in_ide", { ...command });
    } catch (e) {
      toast.error(`Couldn't open ${IDE_LABEL[ide]}`, { description: String(e) });
    }
  };
  return (
    <Button variant="chrome" size="sm" title={label} onClick={() => void openInIde()}>
      {/* The editor's own logo when there is one; an editor with no logo drawn
          gets the generic glyph rather than a broken image. */}
      {icon ? (
        <img src={icon} alt="" className="size-3.5 shrink-0" />
      ) : (
        <SquareArrowOutUpRight className="size-3.5" />
      )}
      {label}
    </Button>
  );
}
