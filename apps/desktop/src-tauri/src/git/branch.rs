use serde::Serialize;
use std::fs;

use super::{git, run_git};
use crate::error::{Error, Result};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// Current branch name, or "HEAD" when detached.
    pub branch: String,
    /// Tracking branch (e.g. "origin/main"), or null when none is configured.
    pub upstream: Option<String>,
    /// Commits the local branch is ahead of its upstream.
    pub ahead: u32,
    /// Commits the local branch is behind its upstream.
    pub behind: u32,
}

/// Current branch plus upstream tracking / ahead-behind counts.
pub fn git_branch(path: String) -> Result<GitBranch> {
    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?;

    // Upstream lookup fails (non-zero) when no tracking branch is set.
    let upstream = run_git(
        &path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .filter(|s| !s.is_empty());

    let (ahead, behind) = if upstream.is_some() {
        // "<behind>\t<ahead>" between upstream and HEAD.
        let counts = run_git(
            &path,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        )
        .unwrap_or_default();
        let mut it = counts.split_whitespace();
        let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (ahead, behind)
    } else {
        (0, 0)
    };

    Ok(GitBranch {
        branch,
        upstream,
        ahead,
        behind,
    })
}

/// The raw bytes of the repo's HEAD file — a change sentinel for a branch that
/// moved outside the app. A checkout rewrites HEAD and nothing else this
/// command touches, and it reads one file instead of spawning git, so the
/// composer can notice a branch switch made in a terminal or an editor within
/// a poll cycle.
pub fn git_head_ref(path: String) -> Result<String> {
    // The project root is usually the repo root, but a project sitting in a
    // subdirectory must not report "not a repo" — the real git_branch runs
    // `git` and walks up itself. Walk up here too.
    let mut cur = std::path::PathBuf::from(&path);
    loop {
        let dot_git = cur.join(".git");
        let parent = cur.parent().map(|p| p.to_path_buf());
        let meta = fs::symlink_metadata(&dot_git);
        match meta {
            Ok(meta) if meta.is_dir() => {
                return fs::read_to_string(dot_git.join("HEAD"))
                    .map(|s| s.trim().to_string())
                    .map_err(|e| Error::new(format!("read HEAD failed: {e}")));
            }
            Ok(meta) if meta.is_file() => {
                // A linked worktree: ".git" is a file naming its gitdir, and
                // this worktree's own HEAD (what `git checkout` rewrites)
                // lives there, not in the common dir.
                let line = fs::read_to_string(&dot_git)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let dir = line
                    .strip_prefix("gitdir:")
                    .map(|d| std::path::PathBuf::from(d.trim().to_string()))
                    .unwrap_or(dot_git);
                return fs::read_to_string(dir.join("HEAD"))
                    .map(|s| s.trim().to_string())
                    .map_err(|e| Error::new(format!("read HEAD failed: {e}")));
            }
            _ => {}
        }
        cur = match parent {
            Some(p) => p,
            None => return Err(Error::new("Not a git repository.")),
        };
    }
}

/// Local branch names.
pub fn git_branches(path: String) -> Result<Vec<String>> {
    let out = run_git(&path, &["branch", "--format=%(refname:short)"])?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// The branch a repo's work merges back into: the remote's own default when it
/// publishes one, else the first conventional name that actually resolves.
/// Returning None means "can't tell", which callers must treat as "nothing is
/// merged" — claiming a branch was merged when it wasn't hides live work.
fn merge_base_ref(path: &str) -> Option<String> {
    if let Ok(head) = run_git(
        path,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    ) {
        if !head.is_empty() {
            return Some(head);
        }
    }
    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find(|name| run_git(path, &["rev-parse", "--verify", "--quiet", name]).is_ok())
        .map(str::to_string)
}

/// The branch this repo's work merges into, short name (no remote prefix).
/// None when it can't be told — a caller must not guess, since "are we on the
/// default branch?" gates a push confirmation.
pub fn git_default_branch(path: String) -> Result<Option<String>> {
    Ok(merge_base_ref(&path).map(|base| base.rsplit('/').next().unwrap_or(&base).to_string()))
}

/// Local branches already merged into the repo's default branch, which the
/// sidebar reads as "this thread's work is done". One call per repo root, not
/// one per thread. The base itself is always reachable from itself, so it is
/// dropped — a repo sitting on `main` is not a pile of finished work.
pub fn git_merged_branches(path: String) -> Result<Vec<String>> {
    let Some(base) = merge_base_ref(&path) else {
        return Ok(vec![]);
    };
    let base_short = base.rsplit('/').next().unwrap_or(&base);
    let out = run_git(
        &path,
        &["branch", "--format=%(refname:short)", "--merged", &base],
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && l != &base && l != base_short)
        .collect())
}

/// Switch to `branch`, creating it (`-b`) when `create` is set.
pub fn git_checkout(path: String, branch: String, create: bool) -> Result<String> {
    if branch.trim().is_empty() {
        return Err(Error::new("Branch name is empty."));
    }
    if create {
        run_git(&path, &["checkout", "-b", &branch])
    } else {
        run_git(&path, &["checkout", &branch])
    }
}

/// Delete a local branch. Uses `-d`, so git refuses to discard a branch whose
/// commits aren't merged — the error is surfaced to the caller rather than
/// forced away.
pub fn git_branch_delete(path: String, branch: String) -> Result<String> {
    if branch.trim().is_empty() {
        return Err(Error::new("Branch name is empty."));
    }
    run_git(&path, &["branch", "-d", &branch])
}

pub(super) fn branch_exists(path: &str, branch: &str) -> bool {
    git(
        path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .map(|o| o.status.success())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::Repo;

    #[test]
    fn reports_the_branch_with_no_upstream_configured() {
        let repo = Repo::new("branch");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let branch = git_branch(repo.path()).unwrap();
        assert_eq!(branch.branch, "main");
        assert_eq!(branch.upstream, None);
        assert_eq!((branch.ahead, branch.behind), (0, 0));
    }

    #[test]
    fn counts_commits_ahead_of_and_behind_the_upstream() {
        let origin = Repo::new("origin");
        origin.write("a.txt", "one\n");
        origin.commit("init");

        let clone = Repo::new("clone");
        // Re-init as a clone of origin, keeping the local identity config.
        clone.run(&["remote", "add", "origin", &origin.path()]);
        clone.run(&["fetch", "origin"]);
        clone.run(&["checkout", "-B", "main", "--track", "origin/main"]);

        clone.write("b.txt", "local\n");
        clone.commit("local work");
        origin.write("c.txt", "remote\n");
        origin.commit("remote work");
        clone.run(&["fetch", "origin"]);

        let branch = git_branch(clone.path()).unwrap();
        assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!((branch.ahead, branch.behind), (1, 1));
    }

    #[test]
    fn creates_switches_and_deletes_branches() {
        let repo = Repo::new("branches");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        git_checkout(repo.path(), "feature".into(), true).unwrap();
        assert_eq!(git_branch(repo.path()).unwrap().branch, "feature");

        let mut names = git_branches(repo.path()).unwrap();
        names.sort();
        assert_eq!(names, vec!["feature", "main"]);

        git_checkout(repo.path(), "main".into(), false).unwrap();
        git_branch_delete(repo.path(), "feature".into()).unwrap();
        assert_eq!(git_branches(repo.path()).unwrap(), vec!["main"]);
    }

    #[test]
    fn head_ref_moves_when_the_branch_changes_and_walks_up() {
        let repo = Repo::new("head_ref");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let before = git_head_ref(repo.path()).unwrap();
        git_checkout(repo.path(), "feature".into(), true).unwrap();
        let after = git_head_ref(repo.path()).unwrap();
        assert_ne!(before, after);

        // A project rooted at a subdirectory still finds the repo.
        let nested = repo.path().to_string() + "/sub";
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(git_head_ref(nested).unwrap(), after);
    }

    #[test]
    fn refuses_to_delete_a_branch_with_unmerged_work() {
        let repo = Repo::new("branch_unmerged");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        git_checkout(repo.path(), "feature".into(), true).unwrap();
        repo.write("b.txt", "work\n");
        repo.commit("feature work");
        git_checkout(repo.path(), "main".into(), false).unwrap();

        assert!(git_branch_delete(repo.path(), "feature".into()).is_err());
        assert!(git_branches(repo.path())
            .unwrap()
            .contains(&"feature".to_string()));
    }

    #[test]
    fn lists_only_branches_already_merged_into_the_default() {
        let repo = Repo::new("merged_branches");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        git_checkout(repo.path(), "done".into(), true).unwrap();
        repo.write("b.txt", "work\n");
        repo.commit("finished work");
        git_checkout(repo.path(), "main".into(), false).unwrap();
        repo.run(&["merge", "--no-ff", "-m", "merge done", "done"]);

        git_checkout(repo.path(), "wip".into(), true).unwrap();
        repo.write("c.txt", "ongoing\n");
        repo.commit("still going");
        git_checkout(repo.path(), "main".into(), false).unwrap();

        let merged = git_merged_branches(repo.path()).unwrap();
        assert_eq!(merged, vec!["done"]);
    }

    #[test]
    fn reports_nothing_merged_when_there_is_no_default_branch_to_compare() {
        let repo = Repo::new("merged_no_base");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        // Rename away from every conventional base name; without one, "merged"
        // is unknowable, and guessing would settle threads that are still live.
        repo.run(&["branch", "-m", "trunk"]);

        assert_eq!(
            git_merged_branches(repo.path()).unwrap(),
            Vec::<String>::new()
        );
    }
}
