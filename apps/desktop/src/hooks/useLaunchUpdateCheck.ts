import { useEffect } from "react";
import { checkForUpdates } from "@/lib/update";

/** Check for a newer signed release once on launch (quiet on failure). */
export function useLaunchUpdateCheck() {
  useEffect(() => {
    void checkForUpdates({ silent: true });
  }, []);
}
