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
import type { Usage } from "@/lib/pricing";
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
  const [usages, setUsages] = useState<Record<string, Usage>>({});
  const [hookSettings, setHookSettings] = useState<string | null>(null);

  // Keep the resolver current inside the stable listener.
  const resolveRef = useRef(resolveSession);
  resolveRef.current = resolveSession;

  // Latest transcript path seen per session (from hook payloads).
  const transcripts = useRef<Record<string, string>>({});

  // Session that raised a desktop notification while the app was unfocused;
  // the app jumps to it when the window regains focus (notification click).
  const pendingAttention = useRef<string | null>(null);

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

      // Remember the transcript path so we can compute token usage. Present on
      // every hook payload, so capture it before any status early-return.
      try {
        const raw = JSON.parse(payload.payload) as { transcript_path?: string };
        if (raw.transcript_path) {
          transcripts.current[payload.session] = raw.transcript_path;
        }
      } catch {
        /* payload not JSON */
      }

      // Refresh usage on turn boundaries.
      if (payload.event === "Stop" || payload.event === "Notification") {
        const tp = transcripts.current[payload.session];
        if (tp) {
          void invoke<Usage>("read_usage", { transcriptPath: tp })
            .then((u) => setUsages((prev) => ({ ...prev, [payload.session]: u })))
            .catch(() => {});
        }
      }

      const status = statusForEvent(payload.event);
      if (!status) return;
      setStatuses((prev) => ({ ...prev, [payload.session]: status }));

      if (status === "waiting" && !document.hasFocus()) {
        const s = resolveRef.current(payload.session);
        pendingAttention.current = payload.session;
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

  /** Drop status + change state for a set of sessions (closed project). */
  function clearSessions(ids: string[]) {
    const set = new Set(ids);
    setStatuses((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => !set.has(id)))
    );
    setChanges((prev) => prev.filter((c) => !set.has(c.session)));
    setUsages((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => !set.has(id)))
    );
    ids.forEach((id) => delete transcripts.current[id]);
  }

  return {
    statuses,
    changes,
    usages,
    hookSettings,
    pendingAttention,
    clearSessions,
  };
}
