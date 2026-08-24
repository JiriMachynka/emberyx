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

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git::{failure, git, is_repo, run_git};

/// Where checkpoint commits are parked. Under `refs/` but outside `refs/heads`
/// and `refs/remotes`, so no branch listing, log, or push ever sees them.
const REF_PREFIX: &str = "refs/emberyx/checkpoints";

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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
#[tauri::command]
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
    run_git(&path, &[
        "update-ref",
        &format!("{REF_PREFIX}/{id}"),
        &sha,
    ])?;
    // The label and thread ride in the ref's own message, so nothing outside
    // the repo has to stay in sync with it.
    run_git(&path, &[
        "config",
        &format!("emberyx.checkpoint.{id}.meta"),
        &format!("{thread_id}\u{1f}{}", label.trim()),
    ])?;

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
#[tauri::command]
pub fn checkpoint_list(path: String, thread_id: Option<String>) -> Result<Vec<Checkpoint>> {
    if !is_repo(&path) {
        return Ok(vec![]);
    }
    let refs = run_git(
        &path,
        &["for-each-ref", "--format=%(refname:short)\u{1f}%(objectname)", REF_PREFIX],
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
    run_git(path, &["rev-parse", "--verify", &format!("{REF_PREFIX}/{id}")])
        .map_err(|_| Error::new(format!("No checkpoint {id}.")))
}

/// What restoring this checkpoint would change, so the user sees it before it
/// happens rather than after.
#[tauri::command]
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
    let untracked = run_git(
        &path,
        &["ls-files", "--others", "--exclude-standard"],
    )
    .unwrap_or_default();
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
#[tauri::command]
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
/// own time; nothing in the working tree changes.
#[tauri::command]
pub fn checkpoint_delete(path: String, id: String) -> Result<()> {
    let sha = sha_of(&path, &id)?;
    run_git(&path, &["update-ref", "-d", &format!("{REF_PREFIX}/{id}"), &sha])?;
    let _ = run_git(
        &path,
        &["config", "--unset", &format!("emberyx.checkpoint.{id}.meta")],
    );
    Ok(())
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
        assert!(changed.iter().any(|c| c.path == "other.txt" && c.kind == "added"));
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
        assert!(!repo.run(&["branch", "--format=%(refname:short)"]).contains("checkpoint"));
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
        assert!(checkpoint_create(path.clone(), "t1".into(), "x".into()).unwrap().is_none());
        assert!(checkpoint_list(path, None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
