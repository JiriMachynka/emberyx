import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { checkForUpdates } from "@/lib/update";

/** Quiet check on launch, and the macOS app-menu "Check for Updates…" item. */
export function useLaunchUpdateCheck() {
  useEffect(() => {
    void checkForUpdates({ silent: true });
  }, []);

  useEffect(() => {
    const unlisten = listen("check-for-updates", () => {
      void checkForUpdates({ silent: false });
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);
}
