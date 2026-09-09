/**
 * Workspace checkpoints.
 *
 * A checkpoint is a snapshot of the working tree taken just before a turn goes
 * on the wire, so one turn's file changes can be undone without unwinding git
 * history. The snapshot itself lives in the repo as an out-of-branch commit
 * (`checkpoints.rs`); this is the client side.
 *
 * Restoring is asymmetric on purpose: files the turn edited or deleted come
 * back, but files it *created* are only removed when explicitly asked for —
 * deleting something the user has since written by hand is not undoable.
 */

import { invoke } from "@tauri-apps/api/core";

export interface Checkpoint {
  id: string;
  sha: string;
  label: string;
  threadId: string;
  createdAt: number;
}

export interface CheckpointChange {
  path: string;
  /** `modified`, `deleted` (would come back), or `added` (would be removed). */
  kind: "modified" | "deleted" | "added";
}

/** A message a checkpoint can be attached to — just the shape this file needs. */
interface Turn {
  role: "user" | "assistant";
  checkpointId?: string;
}

/**
 * Attach a checkpoint to the turn it was taken for: the newest user message
 * that doesn't have one yet. The snapshot is created asynchronously while the
 * turn is already streaming, so it can't simply be appended to the last entry.
 * Returns the same array when there is nothing to attach it to.
 */
export function attachCheckpoint<T extends Turn>(messages: T[], checkpointId: string): T[] {
  // No findLastIndex: the project targets ES2020.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user" || message.checkpointId) continue;
    const next = messages.slice();
    next[i] = { ...message, checkpointId };
    return next;
  }
  return messages;
}

/** Snapshot the working tree. Null when the project isn't a git repo. */
export async function createCheckpoint(
  projectPath: string,
  threadId: string,
  label: string
): Promise<Checkpoint | null> {
  try {
    const point = await invoke<Checkpoint | null>("checkpoint_create", {
      path: projectPath,
      threadId,
      label: label.slice(0, 120),
    });
    return point ?? null;
  } catch {
    // A checkpoint is a safety net, not a precondition — failing to take one
    // must never stop the turn the user asked for.
    return null;
  }
}

export function listCheckpoints(
  projectPath: string,
  threadId?: string
): Promise<Checkpoint[]> {
  return invoke<Checkpoint[]>("checkpoint_list", {
    path: projectPath,
    threadId: threadId ?? null,
  }).then((points) => (Array.isArray(points) ? points : []));
}

/** What a restore would touch — shown before it happens, not after. */
export function checkpointChanges(
  projectPath: string,
  id: string
): Promise<CheckpointChange[]> {
  return invoke<CheckpointChange[]>("checkpoint_changes", {
    path: projectPath,
    id,
  }).then((changes) => (Array.isArray(changes) ? changes : []));
}

export function restoreCheckpoint(
  projectPath: string,
  id: string,
  removeAdded: boolean
): Promise<CheckpointChange[]> {
  return invoke<CheckpointChange[]>("checkpoint_restore", {
    path: projectPath,
    id,
    removeAdded,
  }).then((changes) => (Array.isArray(changes) ? changes : []));
}

export interface CheckpointRangeFile {
  path: string;
  /** `modified`, `added` (created inside the range), or `deleted` (gone). */
  kind: "modified" | "added" | "deleted";
  /** Line counts; null for binary files. */
  additions: number | null;
  deletions: number | null;
}

/** Full old/new contents of one file across a turn's range, for context
 *  expansion. Null when the file is absent on a side, or binary. */
export interface CheckpointRangeContents {
  oldText: string | null;
  newText: string | null;
}

/**
 * One turn's file delta. The Rust side resolves the range end itself — the
 * turn's settle snapshot when one was taken, else the next turn's checkpoint,
 * else the working tree — so manual edits made between turns never land in a
 * turn's delta.
 */
export function checkpointTurnFiles(
  projectPath: string,
  threadId: string,
  fromId: string
): Promise<CheckpointRangeFile[]> {
  return invoke<CheckpointRangeFile[]>("checkpoint_turn_files", {
    path: projectPath,
    threadId,
    fromId,
  }).then((files) => (Array.isArray(files) ? files : []));
}

export function checkpointTurnDiff(
  projectPath: string,
  threadId: string,
  fromId: string,
  file: string
): Promise<string> {
  return invoke<string>("checkpoint_turn_diff", {
    path: projectPath,
    threadId,
    fromId,
    file,
  });
}

export function checkpointTurnContents(
  projectPath: string,
  threadId: string,
  fromId: string,
  file: string
): Promise<CheckpointRangeContents> {
  return invoke<CheckpointRangeContents>("checkpoint_turn_contents", {
    path: projectPath,
    threadId,
    fromId,
    file,
  });
}

/** The turn's list, newest first — the source dropdown's entries. */
export interface TurnRange {
  fromId: string;
  label: string;
}

export function turnRangesNewestFirst(checkpoints: Checkpoint[]): TurnRange[] {
  // checkpoint_list already answers newest first.
  return checkpoints.map((point) => ({ fromId: point.id, label: point.label }));
}

/** +/− totals for a card, ignoring files numstat couldn't count (binary). */
export function sumRangeFiles(files: CheckpointRangeFile[]): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + (file.additions ?? 0),
      deletions: totals.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 }
  );
}

/** One line describing what a restore would do, for the confirmation prompt. */
export function describeRestore(changes: CheckpointChange[]): string {
  const counts = { modified: 0, deleted: 0, added: 0 };
  for (const change of changes) counts[change.kind]++;
  const parts: string[] = [];
  if (counts.modified) parts.push(`${counts.modified} file(s) restored`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted file(s) brought back`);
  if (counts.added) parts.push(`${counts.added} new file(s) left in place`);
  return parts.length ? parts.join(", ") : "Nothing has changed since this checkpoint";
}
