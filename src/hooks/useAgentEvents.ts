import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { statusForEvent } from "@/lib/status";
import { parseChange, type Change } from "@/lib/changes";
import { basename } from "@/lib/path";
import type { HookEvent, Session, SessionStatus } from "@/types";

/**
 * Subscribes to Claude Code hook events (via the Rust listener) and derives
 * per-session status + the agent's file-edit feed. Also loads the settings
 * path used to inject hooks into the agent.
 *
 * @param resolveSession looks up a session by id for notification context.
 */
export function useAgentEvents(
  resolveSession: (id: string) => Session | undefined
) {
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [changes, setChanges] = useState<Change[]>([]);
  const [hookSettings, setHookSettings] = useState<string | null>(null);

  // Keep the resolver current inside the stable listener.
  const resolveRef = useRef(resolveSession);
  resolveRef.current = resolveSession;

  useEffect(() => {
    invoke<string>("hook_config")
      .then(setHookSettings)
      .catch((e) => console.error("hook_config failed:", e));

    (async () => {
      if (!(await isPermissionGranted())) await requestPermission();
    })();

    const unlisten = listen<HookEvent>("hook-event", ({ payload }) => {
      const change = parseChange(payload);
      if (change) setChanges((prev) => [...prev, change]);

      const status = statusForEvent(payload.event);
      if (!status) return;
      setStatuses((prev) => ({ ...prev, [payload.session]: status }));

      if (status === "waiting" && !document.hasFocus()) {
        const s = resolveRef.current(payload.session);
        void isPermissionGranted().then((granted) => {
          if (granted) {
            sendNotification({
              title: "Emberyx — agent needs you",
              body: s ? basename(s.cwd) : "Claude is waiting for input",
            });
          }
        });
      }
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  /** Clear per-project state when opening a new project. */
  function reset() {
    setStatuses({});
    setChanges([]);
  }

  return { statuses, changes, hookSettings, reset };
}
