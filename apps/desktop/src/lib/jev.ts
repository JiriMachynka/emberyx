/**
 * TypeSafe Jev helpers used at the ACP send/settle boundary.
 *
 * The HTTP call lives in Rust. This file is the policy the webview applies
 * afterwards: whether Jev is on, how a skill hint is attached (display text
 * stays untouched), and when a small model should yield to a larger one.
 */

import { invoke } from "@tauri-apps/api/core";
import { checkpointTurnPatch } from "@/lib/checkpoints";
import { isActivityRisk, useActivityRiskStore } from "@/lib/activityRisk";
import { loadSettings } from "@/lib/settings";
import type { ActivityItem, ActivityKind } from "@/types";

export const jevEnabled = (): boolean => loadSettings().jevAutoApprove;

export interface JevSkill {
  name: string;
  description: string;
}

export interface JevTurnPrep {
  skill: string | null;
  injection: boolean;
}

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

/** Activity kinds that can leave a mark — the ones a name-map cannot vouch
 *  for. Reads, searches, plans and reasoning are skipped: there is nothing a
 *  rule cannot already clear in them, and judging each would be one call per
 *  row. */
const GUARDED_KINDS: readonly ActivityKind[] = ["command", "tool"];

const MAX_JUDGED = 2000;
const judged = new Set<string>();
const judgedOutput = new Set<string>();

/** True the first time an id is seen, and once more after the set is dropped
 *  whole — the bound is memory, not meaning: a tool id is never reused. */
const firstSight = (seen: Set<string>, id: string): boolean => {
  if (seen.has(id)) return false;
  if (seen.size >= MAX_JUDGED) seen.clear();
  seen.add(id);
  return true;
};

/** Known credential shapes and long high-entropy runs — the cheap check on the
 *  main path. Jev only ever sees a candidate, never every output. */
const SECRET_SHAPE =
  /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|api[_-]?key\s*[:=]|secret\s*[:=]|password\s*[:=])/i;
const LONG_TOKEN = /\b[A-Za-z0-9+/_-]{32,}\b/;

export const secretish = (text: string): boolean =>
  SECRET_SHAPE.test(text) || LONG_TOKEN.test(text);

/** Label a tool call as it starts. Advisory and fire-and-forget: a verdict
 *  patches the row whenever it lands, and a miss leaves it unlabelled. It
 *  never blocks or approves — the decision stays the user's. */
export const guardActivity = (activity: ActivityItem): void => {
  if (!jevEnabled() || !activity.title) return;
  if (!GUARDED_KINDS.includes(activity.kind)) return;
  if (!firstSight(judged, activity.id)) return;
  void invoke<string | null>("typesafe_call_risk", {
    title: activity.title,
    description: activity.displayDescription ?? null,
    toolKind: activity.kind,
  })
    .then((risk) => {
      if (risk && isActivityRisk(risk))
        useActivityRiskStore.getState().setRisk(activity.id, risk);
    })
    .catch(() => {});
};

/** Label a finished output that looks like it carries a secret. The local
 *  shape check runs first, so Jev only confirms a candidate. */
export const guardOutput = (activity: ActivityItem): void => {
  if (!jevEnabled() || !activity.complete || !activity.output) return;
  if (!secretish(activity.output)) return;
  if (!firstSight(judgedOutput, activity.id)) return;
  void invoke<string | null>("typesafe_output_risk", { text: activity.output })
    .then((risk) => {
      if (risk && isActivityRisk(risk))
        useActivityRiskStore.getState().setRisk(activity.id, risk);
    })
    .catch(() => {});
};
