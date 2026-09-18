/**
 * TypeSafe Jev helpers used at the ACP send/settle boundary.
 *
 * The HTTP call lives in Rust. This file is the policy the webview applies
 * afterwards: whether Jev is on, how a skill hint is attached (display text
 * stays untouched), and when a small model should yield to a larger one.
 */

import { invoke } from "@tauri-apps/api/core";
import { checkpointTurnPatch } from "@/lib/checkpoints";
import { modelVendorKey } from "@/lib/modelCatalog";
import { loadSettings } from "@/lib/settings";

export const jevEnabled = (): boolean => loadSettings().jevAutoApprove;

export interface JevSkill {
  name: string;
  description: string;
}

export interface JevTurnPrep {
  skill: string | null;
  depth: number | null;
  injection: boolean;
}

/** A model id that is cheap/fast rather than a general coding model. */
const SMALL = /haiku|fast|flash|mini|lite|small|nano/i;

export const isSmallModel = (id: string): boolean => SMALL.test(id);

/** First same-vendor catalog entry that is not a small/fast id.
 *
 *  OpenCode's ACP catalog is every provider you hold a credential for, so the
 *  first non-small id is often a GitLab Duo model sitting in front of the
 *  OpenCode Go flash the user actually picked. A bump that changes vendor is
 *  not an upshift — it is a different product. */
export const largerModel = (
  current: string,
  catalog: readonly { value: string }[]
): string | null => {
  if (!current || !isSmallModel(current)) return null;
  const vendor = modelVendorKey(current);
  const next = catalog.find((entry) => {
    if (entry.value === current || isSmallModel(entry.value)) return false;
    return modelVendorKey(entry.value) === vendor;
  });
  return next?.value ?? null;
};

export const skillWireText = (text: string, skill: string | null): string => {
  if (!skill) return text;
  return `[Emberyx: the skill "${skill}" looks relevant. Load it if it fits; skip it if it does not.]\n\n${text}`;
};

/** True when Jev wants a human to look at this turn's file delta. */
export const scoreDiffRisk = async (
  cwd: string,
  threadId: string,
  checkpointId: string
): Promise<boolean> => {
  if (!jevEnabled()) return false;
  try {
    const patch = await checkpointTurnPatch(cwd, threadId, checkpointId);
    return await invoke<boolean>("typesafe_diff_risk", { diff: patch });
  } catch {
    return false;
  }
};

export const withJevReview = <T extends { checkpointId?: string; jevReview?: boolean }>(
  messages: T[],
  checkpointId: string
): T[] =>
  messages.map((message) =>
    message.checkpointId === checkpointId ? { ...message, jevReview: true } : message
  );
