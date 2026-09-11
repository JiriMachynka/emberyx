use std::path::{Path, PathBuf};

use serde::Serialize;

use super::branch::branch_exists;
use super::{failure, git, is_repo, run_git, unquote_path};
use crate::error::{blocking, Error, Result};

// --- remotes and merging ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    /// The merge stopped on conflicts. Not an error — the caller resolves them.
    pub conflicted: bool,
    /// Conflicted paths when `conflicted`, empty otherwise.
    pub files: Vec<String>,
    /// git's own output, shown to the user as-is.
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStages {
    /// Common ancestor (stage 1); absent on add/add conflicts.
    pub base: Option<String>,
    /// Our side (stage 2); absent when we deleted the file.
    pub ours: Option<String>,
    /// Their side (stage 3); absent when they deleted the file.
    pub theirs: Option<String>,
    /// Working-tree contents, conflict markers included.
    pub merged: String,
}

/// Paths git left unmerged in the index.
fn conflicted_files(path: &str) -> Result<Vec<String>> {
    let out = run_git(path, &["diff", "--name-only", "--diff-filter=U"])?;
    Ok(out
        .lines()
        .map(|l| unquote_path(l.trim()))
        .filter(|l| !l.is_empty())
        .collect())
}

/// One merge stage of a conflicted file, or None when that stage doesn't exist
/// (add/add has no base, delete/modify is missing a side).
fn merge_stage(path: &str, stage: u8, file: &str) -> Option<String> {
    let out = git(path, &["show", &format!(":{stage}:{file}")]).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

/// Resolve a frontend-supplied relative path inside the repo. Absolute paths
/// and any `..` are refused, and the resolved parent must still sit under the
/// root — the path arrives from the renderer, so it can't be trusted.
fn repo_file_path(root: &str, file: &str) -> Result<PathBuf> {
    let outside = || Error::new("Path is outside the repository.");
    let rel = Path::new(file);
    if file.trim().is_empty() {
        return Err(Error::new("Path is empty."));
    }
    if !rel.components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        return Err(outside());
    }

    let full = Path::new(root).join(rel);
    let base = std::fs::canonicalize(root).map_err(|_| outside())?;
    let parent = full.parent().ok_or_else(outside)?;
    // Symlinked parents can still lead out of the repo, so compare resolved.
    if !std::fs::canonicalize(parent)
        .map_err(|_| outside())?
        .starts_with(&base)
    {
        return Err(outside());
    }
    Ok(full)
}

/// Fetch from `remote` (default "origin"), dropping refs it no longer has.
#[tauri::command]
pub async fn git_fetch(path: String, remote: Option<String>) -> Result<()> {
    // Off the main thread: network calls take seconds.
    blocking(move || fetch(path, remote)).await
}

fn fetch(path: String, remote: Option<String>) -> Result<()> {
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    run_git(&path, &["fetch", "--prune", &remote])?;
    Ok(())
}

/// Check out a branch that lives on a remote: refresh first, then switch to the
/// local branch if there is one, else create it tracking the remote.
#[tauri::command]
pub async fn git_checkout_remote(
    path: String,
    branch: String,
    remote: Option<String>,
) -> Result<()> {
    blocking(move || checkout_remote(path, branch, remote)).await
}

fn checkout_remote(path: String, branch: String, remote: Option<String>) -> Result<()> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err(Error::new("Branch name is empty."));
    }
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    run_git(&path, &["fetch", "--prune", &remote])?;

    if branch_exists(&path, &branch) {
        run_git(&path, &["checkout", &branch])?;
    } else {
        let tracking = format!("{remote}/{branch}");
        run_git(&path, &["checkout", "-B", &branch, "--track", &tracking])?;
    }
    Ok(())
}

/// Merge `git_ref` into the current branch. Conflicts are a normal outcome, not
/// an error — the caller resolves them through `git_resolve`.
#[tauri::command]
pub async fn git_merge(path: String, git_ref: String) -> Result<MergeOutcome> {
    blocking(move || merge(path, git_ref)).await
}

fn merge(path: String, git_ref: String) -> Result<MergeOutcome> {
    let git_ref = git_ref.trim().to_string();
    if git_ref.is_empty() {
        return Err(Error::new("Merge target is empty."));
    }
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }

    let out = git(&path, &["merge", "--no-edit", &git_ref])?;
    let message = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();

    if out.status.success() {
        return Ok(MergeOutcome {
            conflicted: false,
            files: vec![],
            message,
        });
    }

    // A merge stopped by conflicts leaves unmerged entries in the index;
    // without them the failure is real (dirty tree, unknown ref, …).
    let files = conflicted_files(&path)?;
    if files.is_empty() {
        return Err(failure(&out));
    }
    Ok(MergeOutcome {
        conflicted: true,
        files,
        message,
    })
}

/// Paths still unresolved in an in-progress merge.
#[tauri::command]
pub async fn git_conflicts(path: String) -> Result<Vec<String>> {
    blocking(move || conflicted_files(&path)).await
}

/// The three sides of one conflicted file plus the marked-up working copy.
#[tauri::command]
pub async fn git_conflict_stages(path: String, file: String) -> Result<ConflictStages> {
    blocking(move || conflict_stages(path, file)).await
}

fn conflict_stages(path: String, file: String) -> Result<ConflictStages> {
    let full = repo_file_path(&path, &file)?;
    Ok(ConflictStages {
        base: merge_stage(&path, 1, &file),
        ours: merge_stage(&path, 2, &file),
        theirs: merge_stage(&path, 3, &file),
        merged: std::fs::read_to_string(full).unwrap_or_default(),
    })
}

/// Write the resolved contents of a conflicted file and stage it, which is what
/// clears the conflict as far as git is concerned.
#[tauri::command]
pub async fn git_resolve(path: String, file: String, content: String) -> Result<()> {
    blocking(move || resolve(path, file, content)).await
}

fn resolve(path: String, file: String, content: String) -> Result<()> {
    let full = repo_file_path(&path, &file)?;
    std::fs::write(full, content)?;
    run_git(&path, &["add", "--", &file])?;
    Ok(())
}

/// Throw the merge away and restore the pre-merge working tree.
#[tauri::command]
pub async fn git_merge_abort(path: String) -> Result<()> {
    blocking(move || run_git(&path, &["merge", "--abort"]).map(|_| ())).await
}

/// Commit the merge once every conflict is staged.
#[tauri::command]
pub async fn git_merge_continue(path: String, message: Option<String>) -> Result<()> {
    blocking(move || merge_continue(path, message)).await
}

fn merge_continue(path: String, message: Option<String>) -> Result<()> {
    if !conflicted_files(&path)?.is_empty() {
        return Err(Error::new("Resolve the remaining conflicts first."));
    }
    let message = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    let out = match &message {
        // `--no-edit` keeps git's generated merge message without an editor.
        None => git(&path, &["commit", "--no-edit"])?,
        Some(m) => git(&path, &["commit", "-m", m])?,
    };
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(())
}

/// Whether a merge is in progress (MERGE_HEAD exists).
#[tauri::command]
pub async fn git_merge_state(path: String) -> Result<bool> {
    blocking(move || {
        if !is_repo(&path) {
            return Ok(false);
        }
        Ok::<bool, Error>(
            git(&path, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])?
                .status
                .success(),
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{status_of, Repo};
    use crate::git::{git_branch, git_changes};

    // --- merging ---

    /// A repo where `main` and `feature` changed the same line, so merging one
    /// into the other always conflicts.
    fn conflicting_repo(name: &str) -> Repo {
        let repo = Repo::new(name);
        repo.write("a.txt", "base\n");
        repo.commit("init");
        repo.run(&["checkout", "-b", "feature"]);
        repo.write("a.txt", "theirs\n");
        repo.commit("feature edit");
        repo.run(&["checkout", "main"]);
        repo.write("a.txt", "ours\n");
        repo.commit("main edit");
        repo
    }

    fn merge_ref(repo: &Repo, git_ref: &str) -> Result<MergeOutcome> {
        tauri::async_runtime::block_on(git_merge(repo.path(), git_ref.to_string()))
    }

    fn conflicts_of(repo: &Repo) -> Vec<String> {
        tauri::async_runtime::block_on(git_conflicts(repo.path())).unwrap()
    }

    fn merging(repo: &Repo) -> bool {
        tauri::async_runtime::block_on(git_merge_state(repo.path())).unwrap()
    }

    fn resolve_file(repo: &Repo, file: &str, content: &str) -> Result<()> {
        tauri::async_runtime::block_on(git_resolve(
            repo.path(),
            file.to_string(),
            content.to_string(),
        ))
    }

    #[test]
    fn merges_cleanly_when_the_sides_do_not_overlap() {
        let repo = Repo::new("merge_clean");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        repo.run(&["checkout", "-b", "feature"]);
        repo.write("b.txt", "two\n");
        repo.commit("feature work");
        repo.run(&["checkout", "main"]);

        let outcome = merge_ref(&repo, "feature").unwrap();
        assert!(!outcome.conflicted);
        assert!(outcome.files.is_empty());
        assert!(!merging(&repo));
        assert!(repo.0.join("b.txt").exists());
    }

    #[test]
    fn reports_a_conflicting_merge_without_failing() {
        let repo = conflicting_repo("merge_conflict");

        let outcome = merge_ref(&repo, "feature").unwrap();
        assert!(outcome.conflicted);
        assert_eq!(outcome.files, vec!["a.txt".to_string()]);
        assert!(!outcome.message.is_empty());

        assert!(merging(&repo));
        assert_eq!(conflicts_of(&repo), vec!["a.txt".to_string()]);
    }

    #[test]
    fn surfaces_a_real_merge_failure_as_an_error() {
        let repo = Repo::new("merge_bad_ref");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        assert!(merge_ref(&repo, "no-such-branch").is_err());
        assert!(merge_ref(&repo, "  ").is_err());
        assert!(!merging(&repo));
    }

    #[test]
    fn reads_the_three_stages_of_a_conflicted_file() {
        let repo = conflicting_repo("merge_stages");
        merge_ref(&repo, "feature").unwrap();

        let stages =
            tauri::async_runtime::block_on(git_conflict_stages(repo.path(), "a.txt".to_string()))
                .unwrap();
        assert_eq!(stages.base.as_deref(), Some("base\n"));
        assert_eq!(stages.ours.as_deref(), Some("ours\n"));
        assert_eq!(stages.theirs.as_deref(), Some("theirs\n"));
        assert!(stages.merged.contains("<<<<<<<"));
        assert!(stages.merged.contains("ours") && stages.merged.contains("theirs"));
    }

    #[test]
    fn resolving_clears_the_conflict_and_the_merge_commits() {
        let repo = conflicting_repo("merge_resolve");
        merge_ref(&repo, "feature").unwrap();

        resolve_file(&repo, "a.txt", "resolved\n").unwrap();
        assert!(conflicts_of(&repo).is_empty());

        tauri::async_runtime::block_on(git_merge_continue(repo.path(), None)).unwrap();
        assert!(!merging(&repo));
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "resolved\n"
        );
        // A merge commit, so both sides are now ancestors.
        assert_eq!(repo.run(&["rev-list", "--count", "--merges", "HEAD"]), "1");
    }

    #[test]
    fn refuses_to_continue_while_conflicts_remain() {
        let repo = conflicting_repo("merge_unresolved");
        merge_ref(&repo, "feature").unwrap();

        assert!(tauri::async_runtime::block_on(git_merge_continue(repo.path(), None)).is_err());
        assert!(merging(&repo));
    }

    #[test]
    fn aborting_restores_the_pre_merge_state() {
        let repo = conflicting_repo("merge_abort");
        merge_ref(&repo, "feature").unwrap();

        tauri::async_runtime::block_on(git_merge_abort(repo.path())).unwrap();
        assert!(!merging(&repo));
        assert!(conflicts_of(&repo).is_empty());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "ours\n"
        );
        assert!(git_changes(repo.path()).unwrap().is_empty());
    }

    #[test]
    fn merge_continue_takes_a_custom_message() {
        let repo = conflicting_repo("merge_message");
        merge_ref(&repo, "feature").unwrap();
        resolve_file(&repo, "a.txt", "resolved\n").unwrap();

        tauri::async_runtime::block_on(git_merge_continue(
            repo.path(),
            Some("chore: merge feature".into()),
        ))
        .unwrap();
        assert_eq!(
            repo.run(&["log", "-1", "--pretty=%s"]),
            "chore: merge feature"
        );
    }

    #[test]
    fn resolve_refuses_paths_outside_the_repo() {
        let repo = Repo::new("resolve_escape");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        let escape = repo
            .0
            .parent()
            .unwrap()
            .join("emberyx_test_git_escaped.txt");
        let _ = std::fs::remove_file(&escape);

        assert!(resolve_file(&repo, "../emberyx_test_git_escaped.txt", "pwned\n").is_err());
        assert!(resolve_file(&repo, "a/../../emberyx_test_git_escaped.txt", "pwned\n").is_err());
        assert!(resolve_file(&repo, "/tmp/emberyx_test_git_escaped.txt", "pwned\n").is_err());
        assert!(resolve_file(&repo, "", "pwned\n").is_err());
        assert!(!escape.exists());
    }

    #[test]
    fn resolve_writes_and_stages_a_nested_path() {
        let repo = Repo::new("resolve_nested");
        repo.write("src/a.txt", "one\n");
        repo.commit("init");

        resolve_file(&repo, "src/a.txt", "two\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("src/a.txt")).unwrap(),
            "two\n"
        );
        assert_eq!(
            status_of(&git_changes(repo.path()).unwrap(), "src/a.txt"),
            "M "
        );
    }

    #[test]
    fn fetches_and_checks_out_a_remote_branch() {
        let origin = Repo::new("remote_origin");
        origin.write("a.txt", "one\n");
        origin.commit("init");
        origin.run(&["checkout", "-b", "feat/remote"]);
        origin.write("b.txt", "two\n");
        origin.commit("remote work");
        origin.run(&["checkout", "main"]);

        let clone = Repo::new("remote_clone");
        clone.run(&["remote", "add", "origin", &origin.path()]);
        tauri::async_runtime::block_on(git_fetch(clone.path(), None)).unwrap();

        // No local branch yet, so it is created tracking the remote.
        tauri::async_runtime::block_on(git_checkout_remote(
            clone.path(),
            "feat/remote".into(),
            None,
        ))
        .unwrap();
        let branch = git_branch(clone.path()).unwrap();
        assert_eq!(branch.branch, "feat/remote");
        assert_eq!(branch.upstream.as_deref(), Some("origin/feat/remote"));
        assert!(clone.0.join("b.txt").exists());

        // Second call finds the local branch and just switches to it.
        tauri::async_runtime::block_on(git_checkout_remote(clone.path(), "main".into(), None))
            .unwrap();
        assert_eq!(git_branch(clone.path()).unwrap().branch, "main");
        tauri::async_runtime::block_on(git_checkout_remote(
            clone.path(),
            "feat/remote".into(),
            None,
        ))
        .unwrap();
        assert_eq!(git_branch(clone.path()).unwrap().branch, "feat/remote");
    }

    #[test]
    fn fetch_surfaces_an_unknown_remote() {
        let repo = Repo::new("fetch_bad_remote");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        assert!(
            tauri::async_runtime::block_on(git_fetch(repo.path(), Some("nope".into()))).is_err()
        );
    }
}
