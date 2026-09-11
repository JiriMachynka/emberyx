//! Workspace checkpoints: a snapshot of the working tree taken before a turn,
//! so one agent turn's file changes can be undone without touching git history.
//!
//! A checkpoint is a real commit object written *outside* any branch — the tree
//! is built in a throwaway index, so the user's own staged/unstaged state is
//! never disturbed by taking one. The commit is parked under
//! `refs/emberyx/checkpoints/…`, which keeps it from being garbage-collected
//! and keeps it off every branch, log, and push.
//!
//! `git add -A` into that index means checkpoints follow `.gitignore` — the
//! snapshot covers the source, never `node_modules` or `target`.
//!
//! Restoring is deliberately *not* symmetric with taking one. Files the turn
//! changed or deleted are restored outright; files the turn *created* are only
//! removed when the caller asks, because deleting a file the user has since
//! written by hand is not recoverable from here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::{failure, git, is_repo, run_git};
use crate::time::now_ms;

/// Where checkpoint commits are parked. Under `refs/` but outside `refs/heads`
/// and `refs/remotes`, so no branch listing, log, or push ever sees them.
const REF_PREFIX: &str = "refs/emberyx/checkpoints";

/// Where *settle* snapshots are parked, one per turn: the working tree at the
/// moment the turn finished. A turn's file delta ends here, so edits the user
/// makes between turns belong to no turn's delta — they are only visible in
/// the working-tree review. Keyed by the turn's checkpoint id.
const SETTLE_PREFIX: &str = "refs/emberyx/settles";

/// Cap for a whole-range patch. Per-file patches are bounded by the file they
/// describe; this only stops a diff of the entire range from flooding IPC.
const RANGE_DIFF_LIMIT: usize = 250_000;
/// A whole turn is many files in one patch, so it gets its own, wider budget —
/// one file's limit applied to all of them would cut most reviews short.
const TURN_PATCH_LIMIT: usize = 2_000_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Stable id, also the ref name suffix.
    pub id: String,
    /// The snapshot commit.
    pub sha: String,
    /// What the checkpoint was taken before — usually the turn's prompt.
    pub label: String,
    /// The thread it belongs to, so a pane only offers its own checkpoints.
    pub thread_id: String,
    pub created_at: u64,
}

/// One path a restore would touch, and what it would do to it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChange {
    pub path: String,
    /// `modified`, `deleted` (gone since the checkpoint, would come back), or
    /// `added` (created since, would be removed).
    pub kind: String,
}

/// Two checkpoints can land in the same millisecond — two panes, or a fast
/// loop. A counter keeps both the scratch index and the ref name unique.
static SEQ: AtomicU64 = AtomicU64::new(0);

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::SeqCst)
}

/// A scratch index file, removed when the checkpoint is done with it. Building
/// the tree here is what keeps the user's real index untouched.
struct ScratchIndex(PathBuf);

impl ScratchIndex {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "emberyx-checkpoint-index-{}-{}-{}",
            std::process::id(),
            now_ms(),
            next_seq()
        )))
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        // git leaves its lock behind if it died mid-write; a stale one would
        // block the next checkpoint that happened to reuse the name.
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

fn git_with_index(path: &str, index: &ScratchIndex, args: &[&str]) -> Result<String> {
    let mut full = vec!["-C", path];
    full.extend_from_slice(args);
    let out = std::process::Command::new("git")
        .args(&full)
        .env("GIT_INDEX_FILE", &index.0)
        .output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(failure(&out))
    }
}

/// Snapshot the working tree. Returns `None` when the path is not a repo —
/// checkpoints are a git feature, and a non-repo project simply has none.
pub fn checkpoint_create(
    path: String,
    thread_id: String,
    label: String,
) -> Result<Option<Checkpoint>> {
    if !is_repo(&path) {
        return Ok(None);
    }
    let index = ScratchIndex::new();
    // Seed from HEAD when there is one, so an unchanged file is still in the
    // tree; a repo with no commits yet starts from an empty index.
    if run_git(&path, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        git_with_index(&path, &index, &["read-tree", "HEAD"])?;
    }
    git_with_index(&path, &index, &["add", "-A"])?;
    let tree = git_with_index(&path, &index, &["write-tree"])?;

    let head = run_git(&path, &["rev-parse", "--verify", "HEAD"]).ok();
    let message = format!("emberyx checkpoint: {}", label.trim());
    let mut args = vec!["commit-tree", tree.as_str()];
    if let Some(head) = &head {
        args.push("-p");
        args.push(head);
    }
    args.push("-m");
    args.push(&message);
    let sha = run_git(&path, &args)?;

    let id = format!("{}-{}-{}", now_ms(), next_seq(), &sha[..7.min(sha.len())]);
    run_git(&path, &["update-ref", &format!("{REF_PREFIX}/{id}"), &sha])?;
    // The label and thread ride in the ref's own message, so nothing outside
    // the repo has to stay in sync with it.
    run_git(
        &path,
        &[
            "config",
            &format!("emberyx.checkpoint.{id}.meta"),
            &format!("{thread_id}\u{1f}{}", label.trim()),
        ],
    )?;

    Ok(Some(Checkpoint {
        id,
        sha,
        label: label.trim().to_string(),
        thread_id,
        created_at: now_ms(),
    }))
}

/// Every checkpoint in the repo, newest first. `thread_id` filters to one
/// thread's own snapshots.
pub fn checkpoint_list(path: String, thread_id: Option<String>) -> Result<Vec<Checkpoint>> {
    if !is_repo(&path) {
        return Ok(vec![]);
    }
    let refs = run_git(
        &path,
        &[
            "for-each-ref",
            "--format=%(refname:short)\u{1f}%(objectname)",
            REF_PREFIX,
        ],
    )
    .unwrap_or_default();

    let mut out = vec![];
    for line in refs.lines().filter(|l| !l.trim().is_empty()) {
        let (name, sha) = match line.split_once('\u{1f}') {
            Some(parts) => parts,
            None => continue,
        };
        let id = name.rsplit('/').next().unwrap_or(name).to_string();
        let meta = run_git(&path, &["config", &format!("emberyx.checkpoint.{id}.meta")])
            .unwrap_or_default();
        let (thread, label) = meta.split_once('\u{1f}').unwrap_or(("", meta.as_str()));
        if let Some(wanted) = &thread_id {
            if thread != wanted {
                continue;
            }
        }
        let created_at = id
            .split('-')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        out.push(Checkpoint {
            id,
            sha: sha.to_string(),
            label: label.to_string(),
            thread_id: thread.to_string(),
            created_at,
        });
    }
    out.sort_by_key(|point| std::cmp::Reverse(point.created_at));
    Ok(out)
}

fn sha_of(path: &str, id: &str) -> Result<String> {
    run_git(
        path,
        &["rev-parse", "--verify", &format!("{REF_PREFIX}/{id}")],
    )
    .map_err(|_| Error::new(format!("No checkpoint {id}.")))
}

/// What restoring this checkpoint would change, so the user sees it before it
/// happens rather than after.
pub fn checkpoint_changes(path: String, id: String) -> Result<Vec<CheckpointChange>> {
    let sha = sha_of(&path, &id)?;
    // Compare the snapshot against the working tree, untracked files included —
    // a file the turn created shows up as added only if git can see it.
    let out = git(&path, &["diff", "--name-status", "--no-renames", &sha])?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    let tracked = String::from_utf8_lossy(&out.stdout).to_string();
    let mut changes: Vec<CheckpointChange> = tracked
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(status, file)| CheckpointChange {
            // Read from the snapshot's side: "A" means the snapshot has it and
            // the tree doesn't, so restoring brings it back.
            kind: match status.chars().next() {
                Some('A') => "deleted",
                Some('D') => "added",
                _ => "modified",
            }
            .to_string(),
            path: file.to_string(),
        })
        .collect();

    // Untracked files never appear in a diff against a commit, but they are
    // exactly what an agent turn tends to create.
    let untracked =
        run_git(&path, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
    for file in untracked.lines().filter(|l| !l.trim().is_empty()) {
        if !changes.iter().any(|c| c.path == file) {
            changes.push(CheckpointChange {
                path: file.to_string(),
                kind: "added".into(),
            });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

/// Put the working tree back to the checkpoint.
///
/// `remove_added` controls the destructive half: files that did not exist at
/// the checkpoint are only deleted when it is set. Off by default because a
/// file created after the snapshot may be the user's own work, and deleting it
/// here is not undoable.
pub fn checkpoint_restore(
    path: String,
    id: String,
    remove_added: bool,
) -> Result<Vec<CheckpointChange>> {
    let sha = sha_of(&path, &id)?;
    let changes = checkpoint_changes(path.clone(), id)?;

    // Restore content and deletions in one pass. The index is updated too, so
    // the change shows up as staged rather than as a phantom diff.
    let out = git(&path, &["checkout", &sha, "--", "."])?;
    if !out.status.success() {
        return Err(failure(&out));
    }

    if remove_added {
        for change in changes.iter().filter(|c| c.kind == "added") {
            let target = std::path::Path::new(&path).join(&change.path);
            let _ = std::fs::remove_file(target);
        }
    }
    Ok(changes)
}

/// Drop a checkpoint. The commit becomes unreachable and git collects it in its
/// own time; nothing in the working tree changes. The turn's settle snapshot,
/// if one was taken, goes with it — it would never be read without the
/// checkpoint that keys it.
pub fn checkpoint_delete(path: String, id: String) -> Result<()> {
    let sha = sha_of(&path, &id)?;
    run_git(
        &path,
        &["update-ref", "-d", &format!("{REF_PREFIX}/{id}"), &sha],
    )?;
    // No old-value check: the settle commit's sha is not the checkpoint's, and
    // a missed delete only leaves an unreadable ref behind.
    let _ = run_git(
        &path,
        &["update-ref", "-d", &format!("{SETTLE_PREFIX}/{id}")],
    );
    let _ = run_git(
        &path,
        &[
            "config",
            "--unset",
            &format!("emberyx.checkpoint.{id}.meta"),
        ],
    );
    Ok(())
}

/// Snapshot the working tree at the moment a turn settles, under the turn's
/// checkpoint id. The caller swallows failures: a missed settle only means the
/// turn's delta runs to the next snapshot instead.
pub fn checkpoint_settle(path: String, checkpoint_id: String) -> Result<()> {
    // A settle keys off a checkpoint; without one it would never be read.
    sha_of(&path, &checkpoint_id)?;
    let index = ScratchIndex::new();
    if run_git(&path, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        git_with_index(&path, &index, &["read-tree", "HEAD"])?;
    }
    git_with_index(&path, &index, &["add", "-A"])?;
    let tree = git_with_index(&path, &index, &["write-tree"])?;
    let head = run_git(&path, &["rev-parse", "--verify", "HEAD"]).ok();
    let mut args = vec!["commit-tree", tree.as_str()];
    if let Some(head) = &head {
        args.push("-p");
        args.push(head);
    }
    args.push("-m");
    let message = format!("emberyx settle: {checkpoint_id}");
    args.push(&message);
    let sha = run_git(&path, &args)?;
    run_git(
        &path,
        &[
            "update-ref",
            &format!("{SETTLE_PREFIX}/{checkpoint_id}"),
            &sha,
        ],
    )?;
    Ok(())
}

/// One file a turn changed, with its line counts.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRangeFile {
    pub path: String,
    /// `modified`, `added` (created inside the range), or `deleted` (gone).
    pub kind: String,
    /// Line counts; null for binary files.
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

/// Old and new contents of one file across a turn's range, for the diff
/// renderer's context expansion — expanding a hunk past the patch's 3-line
/// context needs the full file, not the patch.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRangeContents {
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}

/// The tree the working tree has *right now*, untracked files included — the
/// same snapshot a checkpoint takes, minus the commit and the ref. This is a
/// range's last-resort end: a plain `git diff <sha>` would miss files the turn
/// created that were never committed.
fn snapshot_tree(path: &str) -> Result<String> {
    let index = ScratchIndex::new();
    if run_git(path, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        git_with_index(path, &index, &["read-tree", "HEAD"])?;
    }
    git_with_index(path, &index, &["add", "-A"])?;
    git_with_index(path, &index, &["write-tree"])
}

/// Both `--numstat` (counts) and `--name-status` (kind) in one walk, keyed by
/// path. `git diff` accepts a tree object as either side, so `from`/`to` can be
/// a checkpoint sha or a snapshot tree.
fn range_files_between(path: &str, from: &str, to: &str) -> Result<Vec<CheckpointRangeFile>> {
    let numstat = git(path, &["diff", "--numstat", "--no-renames", from, to])?;
    if !numstat.status.success() {
        return Err(failure(&numstat));
    }
    let statuses = git(path, &["diff", "--name-status", "--no-renames", from, to])?;
    if !statuses.status.success() {
        return Err(failure(&statuses));
    }
    let kinds: HashMap<String, String> = String::from_utf8_lossy(&statuses.stdout)
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(status, file)| {
            let kind = match status.chars().next() {
                Some('A') => "added",
                Some('D') => "deleted",
                _ => "modified",
            };
            (file.to_string(), kind.to_string())
        })
        .collect();

    let mut files: Vec<CheckpointRangeFile> = String::from_utf8_lossy(&numstat.stdout)
        .lines()
        .filter_map(|line| {
            // numstat is "adds<TAB>dels<TAB>path"; a binary file shows "-\t-".
            let (adds, rest) = line.split_once('\t')?;
            let (dels, path) = rest.split_once('\t')?;
            let (additions, deletions) = if adds == "-" {
                (None, None)
            } else {
                (Some(adds.parse().ok()?), Some(dels.parse().ok()?))
            };
            Some(CheckpointRangeFile {
                path: path.to_string(),
                kind: kinds
                    .get(path)
                    .cloned()
                    .unwrap_or_else(|| "modified".into()),
                additions,
                deletions,
            })
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Whether the file is textual in this range — a binary blob must not reach a
/// string-typed contents loader.
fn range_file_is_text(path: &str, from: &str, to: &str, file: &str) -> Result<bool> {
    let out = git(
        path,
        &["diff", "--numstat", "--no-renames", from, to, "--", file],
    )?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(!text.starts_with('-') || text.trim().is_empty())
}

fn blob_at(path: &str, treeish: &str, file: &str) -> Option<String> {
    let out = git(path, &["show", &format!("{treeish}:{file}")]).ok()?;
    if !out.status.success() {
        return None;
    }
    let bytes = out.stdout;
    // Cheap binary sniff: NUL in the first 8 KiB. Matches git's own heuristic
    // closely enough for a viewer.
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Where a turn's file delta ends, in priority order:
///
/// 1. The turn's **settle snapshot** — taken when the turn finished, so manual
///    edits made between turns land in no turn's delta (they are only visible
///    in the working-tree review).
/// 2. The next checkpoint of the same thread — the older fallback, for turns
///    that never got a settle.
/// 3. The current working tree — the newest turn before any settle lands.
fn turn_range_end(path: &str, thread_id: &str, from_id: &str) -> Result<String> {
    if let Ok(settled) = run_git(
        path,
        &[
            "rev-parse",
            "--verify",
            &format!("{SETTLE_PREFIX}/{from_id}"),
        ],
    ) {
        return Ok(settled);
    }
    let checkpoints = checkpoint_list(path.to_string(), Some(thread_id.to_string()))?;
    let ascending: Vec<&Checkpoint> = checkpoints.iter().rev().collect();
    if let Some(position) = ascending.iter().position(|point| point.id == from_id) {
        if let Some(next) = ascending.get(position + 1) {
            return Ok(next.sha.clone());
        }
    }
    snapshot_tree(path)
}

/// What changed in one agent turn: from the snapshot taken before it to its
/// settle snapshot (or, without one, the next turn's snapshot — or the working
/// tree for the newest turn that hasn't settled).
pub fn checkpoint_turn_files(
    path: String,
    thread_id: String,
    from_id: String,
) -> Result<Vec<CheckpointRangeFile>> {
    let from = sha_of(&path, &from_id)?;
    let to = turn_range_end(&path, &thread_id, &from_id)?;
    range_files_between(&path, &from, &to)
}

/// Cut a patch to a byte budget without ending mid-line: the frontend parses
/// patches, and a cut line is a hunk git never wrote.
fn truncate_patch(mut diff: String, limit: usize) -> String {
    if diff.len() <= limit {
        return diff;
    }
    diff.truncate(limit);
    if let Some(at) = diff.rfind('\n') {
        diff.truncate(at + 1);
    }
    diff.push_str("… patch truncated\n");
    diff
}

/// Every file a turn changed as one multi-file patch — what the review surface
/// renders in a single scroll, the same shape `git_working_diff` serves the
/// working tree. The per-file command still exists for callers that want one
/// file; this one exists so the review doesn't spawn a git per file.
pub fn checkpoint_turn_patch(path: String, thread_id: String, from_id: String) -> Result<String> {
    let from = sha_of(&path, &from_id)?;
    let to = turn_range_end(&path, &thread_id, &from_id)?;
    let out = git(
        &path,
        &[
            "diff",
            "--no-color",
            "--no-renames",
            from.as_str(),
            to.as_str(),
        ],
    )?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(truncate_patch(
        String::from_utf8_lossy(&out.stdout).to_string(),
        TURN_PATCH_LIMIT,
    ))
}

/// The unified patch for one file inside a turn's range, the way
/// `git_commit_diff` serves the commit timeline.
pub fn checkpoint_turn_diff(
    path: String,
    thread_id: String,
    from_id: String,
    file: String,
) -> Result<String> {
    let from = sha_of(&path, &from_id)?;
    let to = turn_range_end(&path, &thread_id, &from_id)?;
    let out = git(
        &path,
        &[
            "diff",
            "--no-color",
            "--no-renames",
            from.as_str(),
            to.as_str(),
            "--",
            &file,
        ],
    )?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(truncate_patch(
        String::from_utf8_lossy(&out.stdout).to_string(),
        RANGE_DIFF_LIMIT,
    ))
}

/// Full old and new contents of one file across a turn's range, so the diff
/// renderer can expand hunks past the patch's 3-line context. Nulls when the
/// file is absent on a side, or binary.
pub fn checkpoint_turn_contents(
    path: String,
    thread_id: String,
    from_id: String,
    file: String,
) -> Result<CheckpointRangeContents> {
    let from = sha_of(&path, &from_id)?;
    let to = turn_range_end(&path, &thread_id, &from_id)?;
    if !range_file_is_text(&path, &from, &to, &file)? {
        return Ok(CheckpointRangeContents {
            old_text: None,
            new_text: None,
        });
    }
    Ok(CheckpointRangeContents {
        old_text: blob_at(&path, &from, &file),
        new_text: blob_at(&path, &to, &file),
    })
}

/// Orders checkpoint writes. Create and delete both rewrite `.git/config`, and
/// two panes on one repo would otherwise race for `config.lock`. Separate from
/// `git::WRITES` on purpose: a checkpoint must never wait behind a push.
static WRITES: Mutex<()> = Mutex::new(());

pub mod cmd {
    use super::*;

    crate::offload! {
        [WRITES] checkpoint_create(path: String, thread_id: String, label: String) -> Option<Checkpoint>;
        [WRITES] checkpoint_restore(path: String, id: String, remove_added: bool) -> Vec<CheckpointChange>;
        [WRITES] checkpoint_delete(path: String, id: String) -> ();
        checkpoint_settle(path: String, checkpoint_id: String) -> ();
        checkpoint_list(path: String, thread_id: Option<String>) -> Vec<Checkpoint>;
        checkpoint_changes(path: String, id: String) -> Vec<CheckpointChange>;
        checkpoint_turn_files(path: String, thread_id: String, from_id: String) -> Vec<CheckpointRangeFile>;
        checkpoint_turn_patch(path: String, thread_id: String, from_id: String) -> String;
        checkpoint_turn_diff(path: String, thread_id: String, from_id: String, file: String) -> String;
        checkpoint_turn_contents(path: String, thread_id: String, from_id: String, file: String) -> CheckpointRangeContents;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(PathBuf);

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("emberyx_test_ckpt_{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Repo(dir);
            repo.run(&["init", "-b", "main"]);
            repo.run(&["config", "user.email", "test@emberyx.dev"]);
            repo.run(&["config", "user.name", "Emberyx Test"]);
            repo.run(&["config", "commit.gpgsign", "false"]);
            repo.run(&["config", "core.hooksPath", "/nonexistent"]);
            repo
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }

        fn run(&self, args: &[&str]) -> String {
            let out = git(&self.path(), args).unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn write(&self, file: &str, contents: &str) {
            std::fs::write(self.0.join(file), contents).unwrap();
        }

        fn read(&self, file: &str) -> String {
            std::fs::read_to_string(self.0.join(file)).unwrap()
        }

        fn exists(&self, file: &str) -> bool {
            self.0.join(file).exists()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seeded(name: &str) -> Repo {
        let repo = Repo::new(name);
        repo.write("kept.txt", "original");
        repo.run(&["add", "-A"]);
        repo.run(&["commit", "-m", "seed"]);
        repo
    }

    #[test]
    fn a_checkpoint_restores_edited_and_deleted_files() {
        let repo = seeded("restore");
        let point = checkpoint_create(repo.path(), "t1".into(), "before the turn".into())
            .unwrap()
            .unwrap();

        repo.write("kept.txt", "the agent changed this");
        std::fs::remove_file(repo.0.join("kept.txt")).ok();
        repo.write("other.txt", "and wrote this");

        let changed = checkpoint_restore(repo.path(), point.id, false).unwrap();
        assert_eq!(repo.read("kept.txt"), "original");
        assert!(changed
            .iter()
            .any(|c| c.path == "other.txt" && c.kind == "added"));
    }

    // Deleting a file the user may have written by hand is not undoable, so it
    // only happens when asked for.
    #[test]
    fn files_created_after_the_checkpoint_survive_unless_removal_is_asked_for() {
        let repo = seeded("added");
        let point = checkpoint_create(repo.path(), "t1".into(), "before".into())
            .unwrap()
            .unwrap();
        repo.write("new.txt", "created by the turn");

        checkpoint_restore(repo.path(), point.id.clone(), false).unwrap();
        assert!(repo.exists("new.txt"));

        checkpoint_restore(repo.path(), point.id, true).unwrap();
        assert!(!repo.exists("new.txt"));
    }

    // Taking a checkpoint must not disturb what the user has staged.
    #[test]
    fn taking_a_checkpoint_leaves_the_index_alone() {
        let repo = seeded("index");
        repo.write("staged.txt", "staged content");
        repo.run(&["add", "staged.txt"]);
        repo.write("loose.txt", "not staged");
        let before = repo.run(&["status", "--porcelain=v1"]);

        checkpoint_create(repo.path(), "t1".into(), "before".into()).unwrap();

        assert_eq!(repo.run(&["status", "--porcelain=v1"]), before);
    }

    #[test]
    fn checkpoints_are_listed_newest_first_and_filtered_by_thread() {
        let repo = seeded("list");
        checkpoint_create(repo.path(), "t1".into(), "first".into()).unwrap();
        // Ids embed a millisecond stamp; make sure the two differ.
        std::thread::sleep(std::time::Duration::from_millis(2));
        checkpoint_create(repo.path(), "t2".into(), "second".into()).unwrap();

        let all = checkpoint_list(repo.path(), None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].label, "second");

        let mine = checkpoint_list(repo.path(), Some("t1".into())).unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].label, "first");
    }

    // Parked outside refs/heads: they must not turn up as branches or in the log.
    #[test]
    fn checkpoints_stay_off_every_branch() {
        let repo = seeded("hidden");
        checkpoint_create(repo.path(), "t1".into(), "before".into()).unwrap();
        assert!(!repo
            .run(&["branch", "--format=%(refname:short)"])
            .contains("checkpoint"));
        assert!(!repo.run(&["log", "--oneline"]).contains("checkpoint"));
    }

    #[test]
    fn deleting_a_checkpoint_leaves_the_working_tree_alone() {
        let repo = seeded("delete");
        let point = checkpoint_create(repo.path(), "t1".into(), "before".into())
            .unwrap()
            .unwrap();
        repo.write("kept.txt", "edited since");

        checkpoint_delete(repo.path(), point.id.clone()).unwrap();
        assert_eq!(repo.read("kept.txt"), "edited since");
        assert!(checkpoint_list(repo.path(), None).unwrap().is_empty());
        assert!(checkpoint_restore(repo.path(), point.id, false).is_err());
    }

    // A project that isn't a repo has no checkpoints — that is an answer, not
    // an error the caller has to special-case.
    #[test]
    fn a_non_repo_has_no_checkpoints() {
        let dir = std::env::temp_dir().join("emberyx_test_ckpt_norepo");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();
        assert!(checkpoint_create(path.clone(), "t1".into(), "x".into())
            .unwrap()
            .is_none());
        assert!(checkpoint_list(path, None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The card's data: between turn 1's and turn 2's start snapshots sit exactly
    // turn 1's edits.
    #[test]
    fn turn_files_report_kind_and_counts_between_two_checkpoints() {
        let repo = seeded("range");
        let first = checkpoint_create(repo.path(), "t1".into(), "turn one".into())
            .unwrap()
            .unwrap();
        repo.write("kept.txt", "line one\nline two\n");
        repo.write("created.txt", "brand new\n");
        std::thread::sleep(std::time::Duration::from_millis(2));
        checkpoint_create(repo.path(), "t1".into(), "turn two".into()).unwrap();

        let files = checkpoint_turn_files(repo.path(), "t1".into(), first.id.clone()).unwrap();
        let kept = files.iter().find(|f| f.path == "kept.txt").unwrap();
        assert_eq!(kept.kind, "modified");
        assert_eq!(kept.additions, Some(2));
        assert_eq!(kept.deletions, Some(1));
        let created = files.iter().find(|f| f.path == "created.txt").unwrap();
        assert_eq!(created.kind, "added");
        assert_eq!(created.additions, Some(1));
    }

    // The newest turn's range ends at the working tree until a settle exists,
    // so a file the turn created and never committed still shows up.
    #[test]
    fn an_unsettled_turn_reaches_the_working_tree() {
        let repo = seeded("open");
        let point = checkpoint_create(repo.path(), "t1".into(), "before".into())
            .unwrap()
            .unwrap();
        repo.write("kept.txt", "edited\n");
        repo.write("untracked.txt", "a\nb\nc\n");

        let files = checkpoint_turn_files(repo.path(), "t1".into(), point.id).unwrap();
        let untracked = files.iter().find(|f| f.path == "untracked.txt").unwrap();
        assert_eq!(untracked.kind, "added");
        assert_eq!(untracked.additions, Some(3));
        assert!(files
            .iter()
            .any(|f| f.path == "kept.txt" && f.kind == "modified"));
    }

    // The settle is the point: edits made after the turn finished belong to no
    // turn's delta, only to the working-tree review.
    #[test]
    fn a_settled_turn_stops_at_its_settle() {
        let repo = seeded("settle");
        let point = checkpoint_create(repo.path(), "t1".into(), "before".into())
            .unwrap()
            .unwrap();
        repo.write("kept.txt", "the agent's edit\n");
        checkpoint_settle(repo.path(), point.id.clone()).unwrap();
        repo.write("kept.txt", "the agent's edit\nplus the user's\n");

        let files = checkpoint_turn_files(repo.path(), "t1".into(), point.id.clone()).unwrap();
        let kept = files.iter().find(|f| f.path == "kept.txt").unwrap();
        assert_eq!(kept.additions, Some(1));

        // And the settle ref goes away with the checkpoint.
        checkpoint_delete(repo.path(), point.id).unwrap();
        let dir = &repo.0;
        assert!(
            !dir.join(".git/refs/emberyx/settles").exists()
                || std::fs::read_dir(dir.join(".git/refs/emberyx/settles"))
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(true)
        );
    }

    #[test]
    fn turn_files_report_deletions() {
        let repo = seeded("gone");
        let first = checkpoint_create(repo.path(), "t1".into(), "turn one".into())
            .unwrap()
            .unwrap();
        std::fs::remove_file(repo.0.join("kept.txt")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        checkpoint_create(repo.path(), "t1".into(), "turn two".into()).unwrap();

        let files = checkpoint_turn_files(repo.path(), "t1".into(), first.id).unwrap();
        let gone = files.iter().find(|f| f.path == "kept.txt").unwrap();
        assert_eq!(gone.kind, "deleted");
    }

    #[test]
    fn turn_diff_returns_a_patch_for_one_file() {
        let repo = seeded("patch");
        let point = checkpoint_create(repo.path(), "t1".into(), "before".into())
            .unwrap()
            .unwrap();
        repo.write("kept.txt", "the agent changed this\n");

        let patch = checkpoint_turn_diff(
            repo.path(),
            "t1".into(),
            point.id.clone(),
            "kept.txt".into(),
        )
        .unwrap();
        assert!(patch.contains("diff --git a/kept.txt"));
        assert!(patch.contains("+the agent changed this"));
        assert!(!patch.contains("untracked"));
    }

    #[test]
    fn turn_contents_serve_both_sides_for_expansion() {
        let repo = seeded("contents");
        repo.write("kept.txt", "original line\n");
        repo.run(&["add", "-A"]);
        repo.run(&["commit", "-m", "seed kept"]);
        let point = checkpoint_create(repo.path(), "t1".into(), "before".into())
            .unwrap()
            .unwrap();
        repo.write("kept.txt", "original line\nadded line\n");
        repo.write("new.txt", "created\n");

        let contents = checkpoint_turn_contents(
            repo.path(),
            "t1".into(),
            point.id.clone(),
            "kept.txt".into(),
        )
        .unwrap();
        assert_eq!(contents.old_text.as_deref(), Some("original line\n"));
        assert_eq!(
            contents.new_text.as_deref(),
            Some("original line\nadded line\n")
        );

        let created =
            checkpoint_turn_contents(repo.path(), "t1".into(), point.id.clone(), "new.txt".into())
                .unwrap();
        assert!(created.old_text.is_none());
        assert_eq!(created.new_text.as_deref(), Some("created\n"));

        let missing =
            checkpoint_turn_contents(repo.path(), "t1".into(), point.id, "nope.txt".into())
                .unwrap();
        assert!(missing.old_text.is_none() && missing.new_text.is_none());
    }
}
