import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

/**
 * Check GitHub releases for a newer signed build. On `silent` (launch) checks,
 * failures and "up to date" stay quiet; a manual check surfaces both. When an
 * update exists, prompt the user to install + relaunch.
 */
export async function checkForUpdates({ silent }: { silent: boolean }) {
  try {
    const update = await check();
    if (!update) {
      if (!silent) toast.success("Emberyx is up to date.");
      return;
    }
    toast(`Update ${update.version} available`, {
      description: update.body || undefined,
      duration: Infinity,
      action: {
        label: "Install & restart",
        onClick: async () => {
          const id = toast.loading(`Installing ${update.version}…`);
          try {
            await update.downloadAndInstall();
            await relaunch();
          } catch (e) {
            toast.dismiss(id);
            toast.error("Update failed", { description: String(e) });
          }
        },
      },
    });
  } catch (e) {
    if (silent) console.error("update check failed:", e);
    else toast.error("Update check failed", { description: String(e) });
  }
}
