use serde::Serialize;

use super::run_git;
use crate::error::Result;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    /// Stash position (0 = most recent), used as `stash@{index}`.
    pub index: u32,
    /// Full description line from `git stash list`.
    pub label: String,
}

/// Stash all working-tree changes, with an optional message.
pub fn git_stash_push(path: String, message: String) -> Result<String> {
    if message.trim().is_empty() {
        run_git(&path, &["stash", "push"])
    } else {
        run_git(&path, &["stash", "push", "-m", message.trim()])
    }
}

/// List saved stashes, newest first.
pub fn git_stash_list(path: String) -> Result<Vec<GitStash>> {
    let out = run_git(&path, &["stash", "list"])?;
    Ok(out
        .lines()
        .enumerate()
        .map(|(i, line)| GitStash {
            index: i as u32,
            label: line.to_string(),
        })
        .collect())
}

/// Apply the stash at `index`, dropping it too when `pop` is set.
pub fn git_stash_apply(path: String, index: u32, pop: bool) -> Result<String> {
    let stash = format!("stash@{{{}}}", index);
    let action = if pop { "pop" } else { "apply" };
    run_git(&path, &["stash", action, &stash])
}

/// Discard the stash at `index` without applying it.
pub fn git_stash_drop(path: String, index: u32) -> Result<String> {
    let stash = format!("stash@{{{}}}", index);
    run_git(&path, &["stash", "drop", &stash])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::git_changes;
    use crate::git::test_support::Repo;

    #[test]
    fn stashes_lists_applies_and_drops() {
        let repo = Repo::new("stash");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        repo.write("a.txt", "edited\n");

        git_stash_push(repo.path(), "wip: my work".into()).unwrap();
        assert!(git_changes(repo.path()).unwrap().is_empty());

        let stashes = git_stash_list(repo.path()).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert!(stashes[0].label.contains("wip: my work"));

        // apply keeps the entry; pop would remove it.
        git_stash_apply(repo.path(), 0, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "edited\n"
        );
        assert_eq!(git_stash_list(repo.path()).unwrap().len(), 1);

        git_stash_drop(repo.path(), 0).unwrap();
        assert!(git_stash_list(repo.path()).unwrap().is_empty());
    }

    #[test]
    fn stash_indexes_are_newest_first() {
        let repo = Repo::new("stash_order");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        repo.write("a.txt", "first edit\n");
        git_stash_push(repo.path(), "first".into()).unwrap();
        repo.write("a.txt", "second edit\n");
        git_stash_push(repo.path(), "second".into()).unwrap();

        let stashes = git_stash_list(repo.path()).unwrap();
        assert!(stashes[0].label.contains("second"));
        assert!(stashes[1].label.contains("first"));

        // Popping index 0 restores the newest edit.
        git_stash_apply(repo.path(), 0, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "second edit\n"
        );
        assert_eq!(git_stash_list(repo.path()).unwrap().len(), 1);
    }
}
