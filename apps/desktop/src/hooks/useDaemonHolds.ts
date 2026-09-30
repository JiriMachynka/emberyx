import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Whether `emberyxd` is running a process for this session: `null` while the
 * daemon is being asked, then a boolean.
 *
 * Persistent panes used to spawn on open just to find out, which left an agent
 * in the daemon — outliving the app — for every thread that was only looked at.
 * Asking first lets a pane reattach to a running agent and otherwise sleep until
 * the user sends, like a window-scoped one. A daemon that isn't running holds
 * nothing, so an unreachable socket answers `false`.
 */
export function useDaemonHolds(id: string, enabled: boolean) {
  const [answer, setAnswer] = useState<{ id: string; holds: boolean } | null>(
    null
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void invoke<string[]>("daemon_live_agents")
      .then((live) => live.includes(id))
      .catch(() => false)
      .then((holds) => {
        if (!cancelled) setAnswer({ id, holds });
      });
    return () => {
      cancelled = true;
    };
  }, [id, enabled]);

  if (!enabled) return false;
  return answer?.id === id ? answer.holds : null;
}
