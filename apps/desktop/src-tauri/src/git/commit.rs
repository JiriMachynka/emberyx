use serde::Serialize;

use super::branch::git_branch;
use super::{failure, git, is_repo, run_git};
use crate::error::{Error, Result};

/// Commit whatever is staged in the index.
pub fn git_commit(path: String, message: String) -> Result<String> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    if message.trim().is_empty() {
        return Err(Error::new("Commit message is empty."));
    }
    let out = git(&path, &["commit", "-m", &message])?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// How much diff the model drafting a commit message sees. A message is a
/// summary; past this the extra context buys nothing and costs latency on every
/// click.
const DRAFT_DIFF_LIMIT: usize = 24_000;

/// Cut a diff down to the budget on a line boundary, saying so — a message
/// drafted from a silently halved diff would describe half the change as if it
/// were all of it.
fn truncate_diff(diff: &str, limit: usize) -> String {
    if diff.len() <= limit {
        return diff.to_string();
    }
    let mut out = String::with_capacity(limit + 64);
    for line in diff.lines() {
        if out.len() + line.len() + 1 > limit {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("\n[diff truncated — describe only what is shown above]\n");
    out
}

/// What the next commit would contain. With something staged that is the index;
/// with nothing staged it is the whole working tree, which is what the commit
/// menu commits in that case. Untracked files contribute their names only — a
/// new lockfile is megabytes and its name already says what it is.
fn commit_diff(path: &str) -> Result<String> {
    let staged = run_git(path, &["diff", "--cached", "--name-only"])?;
    if !staged.trim().is_empty() {
        return run_git(path, &["diff", "--cached", "--no-color"]);
    }
    let tracked = run_git(path, &["diff", "--no-color"])?;
    let untracked = run_git(path, &["ls-files", "--others", "--exclude-standard"])?;
    Ok(if untracked.trim().is_empty() {
        tracked
    } else {
        format!("{tracked}\n\nNew files:\n{untracked}")
    })
}

/// Draft a commit message from that diff with a one-shot model call. The draft
/// lands in the message box and is never committed on its own: the box is where
/// the user reads it, which is the whole point of drafting rather than
/// committing for them.
#[tauri::command]
pub async fn git_draft_commit_message(
    drafter: tauri::State<'_, crate::draft::Drafter>,
    path: String,
    model: String,
) -> Result<String> {
    // A handle, not a borrow: `spawn_blocking` needs 'static, and the draft's
    // stdout read blocks for as long as the model takes.
    let drafter = drafter.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let diff = commit_diff(&path)?;
        if diff.trim().is_empty() {
            return Err(Error::new("Nothing to describe — no changes."));
        }
        let prompt = format!(
            "Write the git commit message for this change, in Conventional \
             Commits format.\n\n\
             - First line: `type: subject`, or `type(scope): subject` when one \
             area clearly owns the change. Type is one of feat, fix, refactor, \
             perf, docs, test, build, ci, chore — pick the one the diff \
             actually is, not the flattering one.\n\
             - The subject is what changed, imperative and lower-case, the \
             whole line at most 72 characters, no trailing period.\n\
             - Add a short body only when the change needs a why. Otherwise \
             reply with the subject line alone.\n\
             - Write the subject the way a person would. No file-by-file \
             inventory, no bullet padding.\n\
             - Reply with the message only: no quotes, no code fences, no \
             preamble.\n\nDiff:\n{}",
            truncate_diff(&diff, DRAFT_DIFF_LIMIT)
        );
        let raw = drafter.draft(&prompt, &model)?;
        // A model that fenced its answer anyway would otherwise put ``` in the
        // commit itself.
        let message = raw
            .trim()
            .trim_start_matches("```text")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string();
        if message.is_empty() {
            return Err(Error::new("The model returned an empty message."));
        }
        Ok(message)
    })
    .await
    .map_err(|e| crate::err!("git_draft_commit_message join failed: {e}"))?
}

/// Fetch and merge from the tracked remote.
pub fn git_pull(path: String) -> Result<String> {
    run_git(&path, &["pull"])
}

/// Push the current branch to its configured upstream.
pub fn git_push(path: String) -> Result<String> {
    run_git(&path, &["push"])
}

/// Push `branch` to `remote` and set it as the upstream.
pub fn git_push_to(path: String, remote: String, branch: String) -> Result<String> {
    run_git(&path, &["push", "-u", &remote, &branch])
}

/// What a combined commit-and-push actually did. The two halves are reported
/// separately on purpose: a commit that landed and a push that didn't is the
/// one outcome the user must not mistake for "nothing happened".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPush {
    pub committed: bool,
    pub pushed: bool,
    pub branch: String,
    /// Set when the branch has no upstream yet — the caller has to confirm
    /// publishing it before anything is committed.
    pub needs_upstream: bool,
    /// Human-readable outcome, and the push error when the commit landed but
    /// the push did not.
    pub message: String,
}

/// Commit the staged changes and push them in one action.
///
/// Refuses rather than guesses, and always checks *before* committing so a
/// refusal never leaves a commit stranded:
/// - a detached HEAD has no branch to push;
/// - a branch behind its upstream needs a pull first (pushing would be rejected
///   anyway, and force-pushing is never something this does for you);
/// - a branch with no upstream is only published when `set_upstream` says so,
///   because creating a remote branch is not implied by "commit".
pub fn git_commit_and_push(
    path: String,
    message: String,
    set_upstream: bool,
) -> Result<CommitPush> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    if message.trim().is_empty() {
        return Err(Error::new("Commit message is empty."));
    }
    let state = git_branch(path.clone())?;
    if state.branch == "HEAD" {
        return Err(Error::new(
            "HEAD is detached — check out a branch before pushing.",
        ));
    }
    if state.behind > 0 {
        return Err(Error::new(format!(
            "{} is {} commit{} behind {}. Pull first.",
            state.branch,
            state.behind,
            if state.behind == 1 { "" } else { "s" },
            state.upstream.as_deref().unwrap_or("its upstream"),
        )));
    }
    if state.upstream.is_none() && !set_upstream {
        return Ok(CommitPush {
            committed: false,
            pushed: false,
            branch: state.branch,
            needs_upstream: true,
            message: "This branch has no upstream yet.".into(),
        });
    }

    git_commit(path.clone(), message)?;

    let push = match &state.upstream {
        Some(_) => run_git(&path, &["push"]),
        // First push of a new branch: publish it and set the tracking ref.
        None => run_git(&path, &["push", "-u", "origin", &state.branch]),
    };
    match push {
        Ok(out) => Ok(CommitPush {
            committed: true,
            pushed: true,
            branch: state.branch,
            needs_upstream: false,
            message: out,
        }),
        // The commit is already in history — say so, or the user reruns and
        // ends up with an empty second commit or a lost message.
        Err(error) => Ok(CommitPush {
            committed: true,
            pushed: false,
            branch: state.branch,
            needs_upstream: false,
            message: format!("Committed, but the push failed: {error}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::Repo;

    #[test]
    fn truncate_diff_cuts_on_a_line_boundary_and_says_so() {
        let diff = (0..500)
            .map(|i| format!("+line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let cut = truncate_diff(&diff, 200);
        assert!(cut.len() < diff.len());
        assert!(cut.contains("[diff truncated"));
        // Whole lines only: a half-written hunk reads as a different change.
        assert!(cut
            .lines()
            .all(|l| l.is_empty() || l.starts_with("+line") || l.starts_with("[diff truncated")));
    }

    #[test]
    fn a_short_diff_is_left_alone() {
        assert_eq!(truncate_diff("+one\n", 200), "+one\n");
    }

    #[test]
    fn commit_diff_falls_back_to_the_working_tree_when_nothing_is_staged() {
        let repo = Repo::new("draft_diff");
        std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
        repo.run(&["add", "."]);
        repo.run(&["commit", "-m", "first"]);
        std::fs::write(repo.0.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "fresh\n").unwrap();

        let diff = commit_diff(repo.0.to_str().unwrap()).unwrap();
        assert!(diff.contains("+two"));
        // Untracked files are named, not inlined.
        assert!(diff.contains("New files:\nnew.txt"));
        assert!(!diff.contains("+fresh"));
    }

    #[test]
    fn commit_diff_uses_the_index_once_something_is_staged() {
        let repo = Repo::new("draft_diff_staged");
        std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
        repo.run(&["add", "."]);
        repo.run(&["commit", "-m", "first"]);
        std::fs::write(repo.0.join("a.txt"), "two\n").unwrap();
        repo.run(&["add", "a.txt"]);
        std::fs::write(repo.0.join("b.txt"), "unstaged\n").unwrap();

        let diff = commit_diff(repo.0.to_str().unwrap()).unwrap();
        assert!(diff.contains("+two"));
        assert!(!diff.contains("b.txt"));
    }

    /// A bare repo to push into, plus a clone wired to it as `origin`.
    fn with_remote(name: &str) -> (Repo, Repo) {
        let remote_dir = std::env::temp_dir().join(format!("emberyx_test_git_{name}_remote"));
        let _ = std::fs::remove_dir_all(&remote_dir);
        std::fs::create_dir_all(&remote_dir).unwrap();
        let remote = Repo(remote_dir);
        remote.run(&["init", "--bare", "-b", "main"]);

        let local = Repo::new(name);
        local.run(&["remote", "add", "origin", &remote.path()]);
        local.write("seed.txt", "seed");
        local.commit("seed");
        local.run(&["push", "-u", "origin", "main"]);
        (local, remote)
    }

    #[test]
    fn commit_and_push_lands_both_halves() {
        let (repo, remote) = with_remote("commit_push");
        repo.write("a.txt", "one");
        repo.run(&["add", "-A"]);

        let out = git_commit_and_push(repo.path(), "add a".into(), false).unwrap();
        assert!(out.committed && out.pushed, "{}", out.message);
        assert_eq!(out.branch, "main");
        // The remote actually has it, not just the local branch.
        assert!(remote
            .run(&["log", "-1", "--pretty=%s", "main"])
            .contains("add a"));
    }

    // Refusing after committing would strand a commit the user did not expect.
    #[test]
    fn a_branch_behind_its_upstream_is_refused_before_anything_is_committed() {
        let (repo, remote) = with_remote("commit_push_behind");
        // Another clone pushes a commit, leaving `repo` behind.
        let other_dir = std::env::temp_dir().join("emberyx_test_git_commit_push_behind_other");
        let _ = std::fs::remove_dir_all(&other_dir);
        std::fs::create_dir_all(&other_dir).unwrap();
        let other = Repo(other_dir);
        other.run(&["clone", &remote.path(), "."]);
        other.run(&["config", "user.email", "test@emberyx.dev"]);
        other.run(&["config", "user.name", "Emberyx Test"]);
        other.run(&["config", "commit.gpgsign", "false"]);
        other.write("b.txt", "theirs");
        other.commit("theirs");
        other.run(&["push"]);

        repo.run(&["fetch"]);
        repo.write("a.txt", "mine");
        repo.run(&["add", "-A"]);
        let before = repo.run(&["rev-parse", "HEAD"]);

        let error = git_commit_and_push(repo.path(), "mine".into(), false).unwrap_err();
        assert!(error.to_string().contains("Pull first"), "{error}");
        assert_eq!(repo.run(&["rev-parse", "HEAD"]), before);
    }

    // Publishing a branch is not implied by "commit" — it has to be asked for.
    #[test]
    fn a_branch_with_no_upstream_asks_before_publishing() {
        let (repo, remote) = with_remote("commit_push_upstream");
        repo.run(&["checkout", "-b", "feature"]);
        repo.write("a.txt", "one");
        repo.run(&["add", "-A"]);
        let before = repo.run(&["rev-parse", "HEAD"]);

        let asked = git_commit_and_push(repo.path(), "feature work".into(), false).unwrap();
        assert!(asked.needs_upstream);
        assert!(!asked.committed);
        assert_eq!(repo.run(&["rev-parse", "HEAD"]), before);

        let done = git_commit_and_push(repo.path(), "feature work".into(), true).unwrap();
        assert!(done.committed && done.pushed, "{}", done.message);
        assert!(remote
            .run(&["log", "-1", "--pretty=%s", "feature"])
            .contains("feature work"));
    }

    // The commit is in history either way; saying "nothing happened" would send
    // the user back to redo it.
    #[test]
    fn a_failed_push_still_reports_the_commit_that_landed() {
        let (repo, remote) = with_remote("commit_push_broken_remote");
        drop(remote);
        repo.write("a.txt", "one");
        repo.run(&["add", "-A"]);

        let out = git_commit_and_push(repo.path(), "orphaned".into(), false).unwrap();
        assert!(out.committed);
        assert!(!out.pushed);
        assert!(out.message.contains("push failed"), "{}", out.message);
        assert!(repo.run(&["log", "-1", "--pretty=%s"]).contains("orphaned"));
    }

    #[test]
    fn an_empty_message_is_refused() {
        let repo = Repo::new("commit_push_empty_message");
        repo.write("a.txt", "one");
        repo.commit("seed");
        assert!(git_commit_and_push(repo.path(), "   ".into(), false).is_err());
    }
}
