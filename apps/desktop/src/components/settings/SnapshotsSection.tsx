import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/button";
import { Group, Row, StatusDot, SwitchRow } from "@/components/SettingsFields";
import type { SnapshotCaptured } from "@/lib/snapshotA11y";
import type { Settings } from "@/lib/settings";

interface SnapshotsStatus {
  platform: string;
  screenRecording: boolean;
  accessibility: boolean;
  tapRunning: boolean;
  tapError?: string;
}

/**
 * SnapShots — the global both-Shifts capture of the frontmost window. The
 * trigger and the capture live in Rust; this surface owns the switch, the
 * two permission steps and the "Include app text" axis.
 */
export const SnapshotsSection = ({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}) => {
  const [status, setStatus] = useState<SnapshotsStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // Refetch on focus: the common loop is open this page → grant in System
  // Settings → come back, and the grant only becomes visible on a fresh read.
  const refresh = useCallback(() => {
    void invoke<SnapshotsStatus>("snapshots_status")
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const requestPermission = async (kind: "screen" | "accessibility" | "input") => {
    try {
      await invoke("snapshots_request_permission", { kind });
    } catch (e) {
      setTestResult({ ok: false, text: String(e) });
    }
    // The grant itself lands later, when the user returns; the focus listener
    // picks it up. Refresh now too, for the request-prompt path.
    setTimeout(refresh, 500);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const capture = await invoke<SnapshotCaptured>("snapshots_capture", {
        includeText: settings.snapshotsIncludeAppText,
      });
      if (!capture) {
        setTestResult({ ok: false, text: "Capture did not return anything." });
      } else if (capture.error) {
        setTestResult({ ok: false, text: capture.error });
      } else {
        setTestResult({
          ok: true,
          text: `Captured ${capture.app}${capture.title ? ` — ${capture.title}` : ""}`,
        });
      }
    } catch (e) {
      setTestResult({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  // The status query is the platform check: a Rust that answered said which OS
  // it is on. No answer yet renders the full surface — a stale guess would
  // hide controls the sweep and a just-updated app both expect.
  if (status && status.platform !== "macos") {
    return (
      <Group title="SnapShots">
        <p className="text-sm text-muted-foreground">
          SnapShots is macOS only — it captures the frontmost window with the
          system's own screen-capture and accessibility APIs.
        </p>
      </Group>
    );
  }

  const needsCapturePermission = status != null && !status.screenRecording;
  const needsAccessibility = settings.snapshotsIncludeAppText && status != null && !status.accessibility;

  return (
    <>
      <Group
        title="Capture"
        hint="Off by default. When enabled, pressing both Shift keys together captures whatever window you are looking at and attaches it to the focused chat."
      >
        <SwitchRow
          label="Capture the frontmost window"
          hint="Attach a screenshot of the window you are in to the focused composer, the way a paste would."
          checked={settings.snapshotsEnabled}
          onChange={(v) => onUpdate({ snapshotsEnabled: v })}
        />
        {settings.snapshotsEnabled && needsCapturePermission && (
          <div className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">1. Allow capture</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Screen Recording lets Emberyx photograph the frontmost window.
                The capture never leaves your machine. macOS only applies the
                grant to a new launch — if the toggle is already on, quit and
                reopen Emberyx.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void requestPermission("screen")}
                >
                  Open System Settings
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void relaunch()}
                >
                  Quit and reopen
                </Button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">2. Choose shortcut</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Press both Shift keys together — left and right, at the same
                time — anywhere in macOS.
              </p>
            </div>
            <button
              type="button"
              className="justify-self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => onUpdate({ snapshotsEnabled: false })}
            >
              Finish later
            </button>
          </div>
        )}
        <Row
          label="Shortcut"
          hint={
            settings.snapshotsEnabled && status && !status.tapRunning
              ? status.tapError ??
                "The trigger isn't registered yet — macOS asks for Input Monitoring before an app may watch the keyboard globally. Grant it and the shortcut starts working."
              : "A regular key chord can be added later if the modifier pair can't be registered on this Mac."
          }
          control={
            <span className="flex items-center justify-end gap-2 font-mono text-sm">
              <StatusDot
                tone={
                  !settings.snapshotsEnabled
                    ? "off"
                    : status?.tapRunning
                      ? "on"
                      : "warn"
                }
              />
              Both Shift keys
            </span>
          }
        >
          {settings.snapshotsEnabled && status && !status.tapRunning && (
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => void requestPermission("input")}
            >
              Open System Settings
            </Button>
          )}
        </Row>
        <Row
          label="Test capture"
          hint="Captures whatever is frontmost right now and reports what it saw. Nothing is attached."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={testing || !settings.snapshotsEnabled}
              onClick={() => void runTest()}
            >
              {testing ? "Capturing…" : "Test capture"}
            </Button>
          }
        >
          {testResult && (
            <p
              className={`text-xs leading-relaxed ${testResult.ok ? "text-muted-foreground" : "text-red-400"}`}
            >
              {testResult.text}
            </p>
          )}
        </Row>
      </Group>

      <Group title="What the agent receives">
        <SwitchRow
          label="Include app text"
          hint="Also walk the window's accessibility tree, so the agent reads control labels instead of guessing from pixels. Needs the Accessibility permission."
          checked={settings.snapshotsIncludeAppText}
          onChange={(v) => onUpdate({ snapshotsIncludeAppText: v })}
        />
        {needsAccessibility && (
          <div className="flex items-center justify-between gap-8 rounded-lg px-3 py-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Accessibility isn't granted yet — snapshots still attach, just
              without the tree.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => void requestPermission("accessibility")}
            >
              Open System Settings
            </Button>
          </div>
        )}
      </Group>
    </>
  );
};
