use std::path::{Path, PathBuf};

use serde::Serialize;

use super::branch::branch_exists;
use super::{failure, git, is_repo, run_git};
use crate::error::{blocking, Error, Result};

// --- worktrees ---

/// A branch name as one filesystem-safe path segment: "feat/x y" -> "feat-x-y".
fn slugify_branch(branch: &str) -> String {
    let mut out = String::new();
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let slug: String = out
        .trim_matches(|c| c == '-' || c == '.')
        .chars()
        .take(60)
        .collect();
    let slug = slug.trim_end_matches(['-', '.']);
    if slug.is_empty() {
        "wt".to_string()
    } else {
        slug.to_string()
    }
}

/// Where a branch's worktree lives: a `.emberyx-worktrees` directory beside the
/// repo, so checkouts never land inside the repo itself.
fn worktree_dir(repo_root: &Path, branch: &str) -> PathBuf {
    let name = repo_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    repo_root
        .parent()
        .unwrap_or(repo_root)
        .join(".emberyx-worktrees")
        .join(format!("{name}-{}", slugify_branch(branch)))
}

/// Parse `git worktree list --porcelain`: blank-line separated records opening
/// with `worktree <abs>`. The first record is always the main worktree.
fn parse_worktree_list(text: &str) -> Vec<GitWorktree> {
    let mut out: Vec<GitWorktree> = vec![];
    let mut cur: Option<GitWorktree> = None;
    for line in text.lines() {
        if line.trim().is_empty() {
            if let Some(wt) = cur.take() {
                out.push(wt);
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "worktree" => {
                if let Some(wt) = cur.take() {
                    out.push(wt);
                }
                cur = Some(GitWorktree {
                    path: value.to_string(),
                    branch: String::new(),
                    head: String::new(),
                    is_main: out.is_empty(),
                    locked: false,
                    prunable: false,
                });
            }
            "HEAD" => {
                if let Some(wt) = cur.as_mut() {
                    wt.head = value.to_string();
                }
            }
            // `detached` and `bare` records carry no branch, so "" stands in.
            "branch" => {
                if let Some(wt) = cur.as_mut() {
                    wt.branch = value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string();
                }
            }
            "locked" => {
                if let Some(wt) = cur.as_mut() {
                    wt.locked = true;
                }
            }
            "prunable" => {
                if let Some(wt) = cur.as_mut() {
                    wt.prunable = true;
                }
            }
            _ => {}
        }
    }
    if let Some(wt) = cur {
        out.push(wt);
    }
    out
}

/// Resolved absolute path, so paths built here compare equal to the ones git
/// reports (temp and home dirs are symlinks on macOS).
fn canonical(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy().to_string();
    let trimmed = text.trim_end_matches('/');
    if trimmed.is_empty() {
        text
    } else {
        trimmed.to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    /// Absolute path to the checkout.
    pub path: String,
    /// Short branch name, or "" when detached or bare.
    pub branch: String,
    pub head: String,
    /// The repo's original checkout, which can't be removed.
    pub is_main: bool,
    pub locked: bool,
    /// Registered but its directory is gone — `git worktree prune` clears it.
    pub prunable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoRoot {
    /// Top level of the checkout `path` sits in.
    pub root: String,
    /// Top level of the main worktree, which owns the shared git dir.
    pub main_root: String,
    /// Current branch of `root`, or "HEAD" when detached.
    pub branch: String,
    pub is_worktree: bool,
}

/// Every worktree registered on the repo, main one first.
pub fn git_worktrees(path: String) -> Result<Vec<GitWorktree>> {
    if !is_repo(&path) {
        return Ok(vec![]);
    }
    let out = git(&path, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_list(&String::from_utf8_lossy(&out.stdout)))
}

/// Which repo (and which of its worktrees) a path belongs to.
pub fn git_repo_root(path: String) -> Result<GitRepoRoot> {
    let root = run_git(&path, &["rev-parse", "--show-toplevel"])?;
    let main_root = main_worktree_root(&path)?;
    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?;

    let root = canonical(Path::new(&root));
    let main_root = canonical(&main_root);
    Ok(GitRepoRoot {
        is_worktree: root != main_root,
        root,
        main_root,
        branch,
    })
}

/// The main worktree's top level, via the shared git dir rather than
/// `--show-toplevel` — from inside a worktree the latter points at the
/// worktree, which would nest the next checkout under it.
fn main_worktree_root(path: &str) -> Result<PathBuf> {
    let common = run_git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    Ok(Path::new(&common)
        .parent()
        .ok_or_else(|| Error::new("Could not resolve the repository root."))?
        .to_path_buf())
}

/// Check `branch` out into its own worktree and hand back the directory.
/// Idempotent: a branch that's already in a worktree returns that one.
#[tauri::command]
pub async fn git_worktree_add(
    path: String,
    branch: String,
    create: bool,
    base: Option<String>,
) -> Result<String> {
    // Off the main thread: checking out a big tree takes seconds.
    blocking(move || worktree_add(path, branch, create, base)).await
}

fn worktree_add(
    path: String,
    branch: String,
    create: bool,
    base: Option<String>,
) -> Result<String> {
    if branch.trim().is_empty() {
        return Err(Error::new("Branch name is empty."));
    }
    let branch = branch.trim().to_string();
    // `-b` on a branch that already exists is a hard error; check it out instead.
    let create = create && !branch_exists(&path, &branch);

    let main_root = main_worktree_root(&path)?;
    let existing = parse_worktree_list(&String::from_utf8_lossy(
        &git(&path, &["worktree", "list", "--porcelain"])?.stdout,
    ));
    if let Some(wt) = existing.iter().find(|w| w.branch == branch) {
        return Ok(wt.path.clone());
    }

    // A leftover directory (a removed worktree that wasn't cleaned up) must not
    // be reused — git refuses to add into a non-empty path.
    let first = worktree_dir(&main_root, &branch);
    let mut dir = first.clone();
    let mut n = 2;
    while dir.exists() && n <= 20 {
        dir = first.with_file_name(format!(
            "{}-{n}",
            first.file_name().unwrap_or_default().to_string_lossy()
        ));
        n += 1;
    }
    if dir.exists() {
        return Err(Error::new("Too many worktrees for this branch."));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let dir_arg = dir.to_string_lossy().to_string();
    let base_ref = base.unwrap_or_else(|| "HEAD".to_string());
    let mut args = vec!["worktree", "add"];
    if create {
        args.extend_from_slice(&["-b", &branch]);
    }
    args.push(&dir_arg);
    args.push(if create { &base_ref } else { &branch });

    let out = git(&path, &args)?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(canonical(&dir))
}

/// Unregister a worktree and delete its directory. `force` also throws away
/// uncommitted changes in it.
pub fn git_worktree_remove(path: String, worktree: String, force: bool) -> Result<String> {
    let main_root = canonical(&main_worktree_root(&path)?);
    if canonical(Path::new(&worktree)) == main_root {
        return Err(Error::new("Can't remove the main worktree."));
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&worktree);
    run_git(&path, &args)
}

/// Drop registrations whose directories are gone.
pub fn git_worktree_prune(path: String) -> Result<String> {
    run_git(&path, &["worktree", "prune"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_branch;
    use crate::git::test_support::Repo;

    /// Drive the async worktree command from a sync test.
    fn add_worktree(repo: &Repo, branch: &str, create: bool) -> Result<String> {
        tauri::async_runtime::block_on(git_worktree_add(
            repo.path(),
            branch.to_string(),
            create,
            None,
        ))
    }

    #[test]
    fn slugifies_branch_names_for_directories() {
        assert_eq!(slugify_branch("main"), "main");
        assert_eq!(slugify_branch("feat/x y"), "feat-x-y");
        // Runs of separators collapse, and edges are trimmed.
        assert_eq!(slugify_branch("feat//--x"), "feat-x");
        assert_eq!(slugify_branch(".hidden."), "hidden");
        assert_eq!(slugify_branch("release/v1.2.0"), "release-v1.2.0");
        // Nothing usable left, so a stable fallback rather than an empty segment.
        assert_eq!(slugify_branch("---"), "wt");
        assert_eq!(slugify_branch(""), "wt");
        assert_eq!(slugify_branch(&"a".repeat(80)), "a".repeat(60));
    }

    #[test]
    fn parses_worktree_list_porcelain() {
        let text = "\
worktree /repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repos/.emberyx-worktrees/app-feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feat/thing

worktree /repos/.emberyx-worktrees/app-detached
HEAD 3333333333333333333333333333333333333333
detached

worktree /repos/.emberyx-worktrees/app-held
HEAD 4444444444444444444444444444444444444444
branch refs/heads/held
locked being kept around

worktree /repos/.emberyx-worktrees/app-gone
HEAD 5555555555555555555555555555555555555555
branch refs/heads/gone
prunable gitdir file points to non-existent location
";
        let trees = parse_worktree_list(text);
        assert_eq!(trees.len(), 5);

        assert_eq!(trees[0].path, "/repos/app");
        assert_eq!(trees[0].branch, "main");
        assert_eq!(trees[0].head.len(), 40);
        assert!(trees[0].is_main);
        assert!(trees.iter().skip(1).all(|w| !w.is_main));

        // Short name, even when the branch itself is a path.
        assert_eq!(trees[1].branch, "feat/thing");
        // Detached HEAD has no branch to report.
        assert_eq!(trees[2].branch, "");

        assert!(trees[3].locked && !trees[3].prunable);
        assert!(trees[4].prunable && !trees[4].locked);
        assert!(trees.iter().take(3).all(|w| !w.locked && !w.prunable));
    }

    #[test]
    fn adds_a_worktree_for_a_new_branch() {
        let repo = Repo::new("wt_add");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let dir = add_worktree(&repo, "feat/wt-add", true).unwrap();
        let path = std::path::PathBuf::from(&dir);
        assert!(path.is_dir());
        // Beside the repo, never inside it.
        assert!(!path.starts_with(&repo.0));
        assert!(dir.contains(".emberyx-worktrees"));
        let repo_name = repo.0.file_name().unwrap().to_string_lossy();
        assert!(dir.ends_with(&format!("{repo_name}-feat-wt-add")));
        assert_eq!(
            std::fs::read_to_string(path.join("a.txt")).unwrap(),
            "one\n"
        );

        let trees = git_worktrees(repo.path()).unwrap();
        assert_eq!(trees.len(), 2);
        assert!(trees[0].is_main);
        let added = trees.iter().find(|w| w.branch == "feat/wt-add").unwrap();
        assert!(!added.is_main && !added.prunable);
    }

    #[test]
    fn reuses_the_worktree_for_a_branch_already_checked_out() {
        let repo = Repo::new("wt_reuse");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let first = add_worktree(&repo, "wt-reuse", true).unwrap();
        let second = add_worktree(&repo, "wt-reuse", true).unwrap();
        assert_eq!(
            canonical(std::path::Path::new(&first)),
            canonical(std::path::Path::new(&second))
        );
        assert_eq!(git_worktrees(repo.path()).unwrap().len(), 2);
    }

    #[test]
    fn checks_out_an_existing_branch_into_a_worktree() {
        let repo = Repo::new("wt_existing");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        repo.run(&["branch", "wt-existing"]);

        let dir = add_worktree(&repo, "wt-existing", false).unwrap();
        assert!(std::path::Path::new(&dir).is_dir());

        let root = git_repo_root(dir).unwrap();
        assert_eq!(root.branch, "wt-existing");
        // The main worktree stays on main.
        assert_eq!(git_branch(repo.path()).unwrap().branch, "main");
    }

    #[test]
    fn removes_a_worktree() {
        let repo = Repo::new("wt_remove");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let dir = add_worktree(&repo, "wt-remove", true).unwrap();
        git_worktree_remove(repo.path(), dir.clone(), false).unwrap();

        assert!(!std::path::Path::new(&dir).exists());
        assert_eq!(git_worktrees(repo.path()).unwrap().len(), 1);
    }

    #[test]
    fn refuses_to_remove_a_dirty_worktree_without_force() {
        let repo = Repo::new("wt_dirty");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let dir = add_worktree(&repo, "wt-dirty", true).unwrap();
        std::fs::write(std::path::Path::new(&dir).join("a.txt"), "edited\n").unwrap();

        assert!(git_worktree_remove(repo.path(), dir.clone(), false).is_err());
        assert!(std::path::Path::new(&dir).exists());

        git_worktree_remove(repo.path(), dir.clone(), true).unwrap();
        assert!(!std::path::Path::new(&dir).exists());
    }

    #[test]
    fn refuses_to_remove_the_main_worktree() {
        let repo = Repo::new("wt_main");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let err = git_worktree_remove(repo.path(), repo.path(), true).unwrap_err();
        assert!(
            err.to_string().contains("main worktree"),
            "unexpected error: {err}"
        );
        assert!(repo.0.join("a.txt").exists());
    }

    #[test]
    fn reports_the_owning_repo_from_inside_a_worktree() {
        let repo = Repo::new("wt_root");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        let dir = add_worktree(&repo, "wt-root", true).unwrap();

        let from_worktree = git_repo_root(dir.clone()).unwrap();
        assert!(from_worktree.is_worktree);
        assert_eq!(from_worktree.root, canonical(std::path::Path::new(&dir)));
        assert_eq!(from_worktree.main_root, canonical(&repo.0));
        assert_eq!(from_worktree.branch, "wt-root");

        let from_main = git_repo_root(repo.path()).unwrap();
        assert!(!from_main.is_worktree);
        assert_eq!(from_main.root, from_main.main_root);
        assert_eq!(from_main.root, canonical(&repo.0));
    }

    #[test]
    fn prunes_a_deleted_worktree() {
        let repo = Repo::new("wt_prune");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let dir = add_worktree(&repo, "wt-prune", true).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        let stale = git_worktrees(repo.path()).unwrap();
        assert_eq!(stale.len(), 2);
        assert!(stale.iter().any(|w| w.prunable));

        git_worktree_prune(repo.path()).unwrap();
        let left = git_worktrees(repo.path()).unwrap();
        assert_eq!(left.len(), 1);
        assert!(left[0].is_main);
    }
}
