import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { processImage } from "@/components/composer/processImage";
import { useAgentStore } from "@/lib/agentStore";
import { formatA11yTree, type SnapshotCaptured } from "@/lib/snapshotA11y";
import type { Settings } from "@/lib/settings";

/** Turn one capture payload into a composer attachment: decode, downsize to
 *  the vision cap, and format the tree the agent will receive. */
const snapshotToImage = async (payload: SnapshotCaptured) => {
  if (!payload.png) return null;
  const blob = await (await fetch(`data:image/png;base64,${payload.png}`)).blob();
  const image = await processImage(
    new File([blob], "snapshot.png", { type: "image/png" }),
    "image/png"
  );
  return {
    ...image,
    snapshot: {
      app: payload.app,
      title: payload.title,
      a11y: formatA11yTree(payload.a11y) || undefined,
    },
  };
};

/**
 * SnapShots glue: mirrors the settings keys into the Rust tap (started only
 * while enabled, torn down on disable — and on exit, Rust-side) and lands
 * `snapshot-captured` events in the store's one-slot inbox, where the focused
 * composer consumes them. Focus itself is handled Rust-side, right after the
 * capture.
 */
export function useSnapshots(settings: Settings) {
  useEffect(() => {
    void invoke("snapshots_set_enabled", {
      enabled: settings.snapshotsEnabled,
      includeText: settings.snapshotsIncludeAppText,
    }).catch((e) => console.error("[emberyx] snapshots_set_enabled failed", e));
  }, [settings.snapshotsEnabled, settings.snapshotsIncludeAppText]);

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<SnapshotCaptured>("snapshot-captured", (ev) => {
      void snapshotToImage(ev.payload)
        .then((image) => {
          if (cancelled) return;
          if (image) useAgentStore.getState().setPendingSnapshot(image);
        })
        .catch((e) => console.error("[emberyx] snapshot attach failed", e));
      if (ev.payload.error) {
        toast.error("SnapShots couldn't capture", {
          description: ev.payload.error,
        });
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, []);
}
