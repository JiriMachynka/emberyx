import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { statusForEvent } from "@/lib/status";
import { classify, issueTitle, resetLabel } from "@/lib/accountState";
import { parseChange } from "@/lib/changes";
import { basename } from "@/lib/path";
import { useAgentStore } from "@/lib/agentStore";
import { loadSettings, type Settings } from "@/lib/settings";
import type { NotificationKind } from "@/lib/notifications";
import type { Usage } from "@/lib/pricing";
import type { HookEvent, Session } from "@/types";

/**
 * Raises an OS notification, honouring the notification settings. Kinds the
 * user switched off, and (optionally) anything raised while the window is
 * focused, are dropped.
 */
export async function notifyNative(
  settings: Settings,
  kind: NotificationKind,
  title: string,
  body: string
): Promise<void> {
  if (kind === "done" && !settings.notifyOnDone) return;
  if (kind === "error" && !settings.notifyOnError) return;
  if (
    (kind === "rate-limited" || kind === "logged-out") &&
    !settings.notifyOnAccountIssue
  ) {
    return;
  }
  if (settings.notifyOnlyWhenUnfocused && document.hasFocus()) return;
  if (!(await isPermissionGranted())) return;
  sendNotification({
    title,
    body,
    sound: settings.notifySound ? "default" : undefined,
  });
}

/**
 * Subscribes to Claude Code hook events (via the Rust listener) and pushes the
 * derived per-session status + file-edit feed into the agent store, so live
 * updates re-render only the components that select them. Also loads the
 * settings path used to inject hooks into the agent.
 *
 * @param resolveSession looks up a session by id for notification context.
 */
export function useAgentEvents(
  resolveSession: (id: string) => Session | undefined
) {
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

    const store = useAgentStore.getState();

    const unlisten = listen<HookEvent>("hook-event", ({ payload }) => {
      const change = parseChange(payload);
      if (change) store.addChange(change);

      // Remember the transcript path so we can compute token usage. Present on
      // every hook payload, so capture it before any status early-return.
      let message: string | undefined;
      try {
        const raw = JSON.parse(payload.payload) as {
          transcript_path?: string;
          message?: string;
        };
        if (raw.transcript_path) {
          transcripts.current[payload.session] = raw.transcript_path;
        }
        message = raw.message;
      } catch {
        /* payload not JSON */
      }

      // Refresh usage on turn boundaries.
      if (payload.event === "Stop" || payload.event === "Notification") {
        const tp = transcripts.current[payload.session];
        if (tp) {
          void invoke<Usage>("read_usage", { transcriptPath: tp })
            .then((u) => store.setUsage(payload.session, u))
            .catch(() => {});
        }
      }

      // The hook path is the only signal a terminal session gives us, so an
      // account block has to be recognised here too — it reads as a plain
      // Notification otherwise.
      const issue = message ? classify(message) : null;
      if (issue) {
        const s = resolveRef.current(payload.session);
        store.reportAccountIssue(payload.session, issue);
        const kind = issue.kind === "rate_limit" ? "rate-limited" : "logged-out";
        const title = issueTitle(issue);
        const reset = resetLabel(issue);
        const body = reset ? `${issue.message} — ${reset}` : issue.message;
        store.pushNotification({
          session: payload.session,
          project: s ? basename(s.cwd) : "Claude",
          kind,
          title,
          body,
        });
        if (!document.hasFocus()) pendingAttention.current = payload.session;
        void notifyNative(loadSettings(), kind, title, body);
        return;
      }

      const status = statusForEvent(payload.event, message);
      if (!status) return;
      store.setStatus(payload.session, status);

      // Only turn boundaries are worth a notification; SubagentStop fires far
      // too often to be one.
      if (payload.event !== "Stop" && payload.event !== "Notification") return;

      const s = resolveRef.current(payload.session);
      const project = s ? basename(s.cwd) : "Claude";
      const settings = loadSettings();

      if (payload.event === "Stop") {
        const title = `${project} — done`;
        const body = "Claude finished responding";
        store.pushNotification({
          session: payload.session,
          project,
          kind: "done",
          title,
          body,
        });
        void notifyNative(settings, "done", title, body);
        return;
      }

      store.pushNotification({
        session: payload.session,
        project,
        kind: "needs-input",
        title: `${project} — needs you`,
        body: "Claude is waiting for input",
      });
      // Clicking the notification brings the window back; remember where to jump.
      if (!document.hasFocus()) pendingAttention.current = payload.session;
      void notifyNative(
        settings,
        "needs-input",
        "Emberyx — agent needs you",
        project
      );
    });

    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  return { hookSettings, pendingAttention };
}
