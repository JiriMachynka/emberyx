use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::{Error, Result};

mod branch;
mod changes;
mod commit;
mod graph;
mod log;
mod merge;
mod remote;
mod stash;
#[cfg(test)]
mod test_support;
mod worktree;

pub use branch::*;
pub use changes::*;
pub use commit::*;
pub use graph::*;
pub use log::*;
pub use merge::*;
pub use remote::*;
pub use stash::*;
pub use worktree::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Path relative to the repo root.
    pub path: String,
    /// Two-char porcelain status (e.g. " M", "??", "A ").
    pub status: String,
    pub untracked: bool,
}

/// Unquote a git C-quoted path. Git wraps paths containing spaces, unicode, or
/// control chars in double quotes with backslash escapes (`\"`, `\\`, `\t`,
/// `\n`, and octal `\nnn` byte escapes). Non-quoted paths are returned as-is.
fn unquote_path(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return s.to_string();
    }
    let inner = &bytes[1..bytes.len() - 1];
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] != b'\\' {
            out.push(inner[i]);
            i += 1;
            continue;
        }
        i += 1;
        if i >= inner.len() {
            out.push(b'\\');
            break;
        }
        match inner[i] {
            b'"' => out.push(b'"'),
            b'\\' => out.push(b'\\'),
            b't' => out.push(b'\t'),
            b'n' => out.push(b'\n'),
            c @ b'0'..=b'7' => {
                // Octal escape: up to 3 digits, one raw byte.
                let mut val = (c - b'0') as u32;
                let mut n = 1;
                while n < 3 && i + 1 < inner.len() && (b'0'..=b'7').contains(&inner[i + 1]) {
                    i += 1;
                    val = val * 8 + (inner[i] - b'0') as u32;
                    n += 1;
                }
                out.push(val as u8);
            }
            other => {
                out.push(b'\\');
                out.push(other);
            }
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Run `git -C <path> <args>` and hand back the raw output. Every git call in
/// this module goes through here, so process spawning and the repo check live
/// in exactly one place.
pub(crate) fn git(path: &str, args: &[&str]) -> Result<Output> {
    let mut full = vec!["-C", path];
    full.extend_from_slice(args);
    Ok(Command::new("git").args(&full).output()?)
}

/// Like `git`, but feeds `input` to the command's stdin (`git apply -`).
fn git_stdin(path: &str, args: &[&str], input: &str) -> Result<Output> {
    let mut child = Command::new("git")
        .args(["-C", path])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| Error::new("could not open git stdin"))?
        .write_all(input.as_bytes())?;
    Ok(child.wait_with_output()?)
}

/// git's own message for a failed command: stderr, falling back to stdout.
pub(crate) fn failure(out: &Output) -> Error {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    Error::new(format!("{}{}", stdout, stderr).trim())
}

pub(crate) fn is_repo(path: &str) -> bool {
    git(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a git command in a repo, returning trimmed stdout on success or git's
/// own error message on failure.
///
/// The repo check runs only once the command has failed: checking up front
/// cost a second process on every call, and every command routed through here
/// fails outside a repo anyway — the check only picks the friendlier message.
pub(crate) fn run_git(path: &str, args: &[&str]) -> Result<String> {
    let out = git(path, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else if !is_repo(path) {
        Err(Error::new("Not a git repository."))
    } else {
        Err(failure(&out))
    }
}

/// Orders the commands that write the index, refs or working tree. They used
/// to queue on the main thread; off it, two fast clicks would race for
/// `index.lock` and one would fail.
pub(crate) static WRITES: Mutex<()> = Mutex::new(());

pub mod cmd {
    use super::*;

    crate::offload! {
        git_changes(path: String) -> Vec<GitFile>;
        git_file_diff(path: String, file: String, untracked: bool, staged: bool, ignore_whitespace: Option<bool>) -> String;
        git_working_diff(path: String, staged: bool, ignore_whitespace: Option<bool>) -> String;
        git_file_log(path: String, file: String) -> Vec<GitCommit>;
        git_show_file(path: String, sha: String, file: String) -> String;
        git_log(path: String, limit: u32) -> Vec<GitLogEntry>;
        git_commit_diff(path: String, sha: String, file: String) -> String;
        git_pickaxe(path: String, file: String, term: String) -> Vec<String>;
        git_branch(path: String) -> GitBranch;
        git_head_ref(path: String) -> String;
        git_branches(path: String) -> Vec<String>;
        git_default_branch(path: String) -> Option<String>;
        git_merged_branches(path: String) -> Vec<String>;
        git_worktrees(path: String) -> Vec<GitWorktree>;
        git_repo_root(path: String) -> GitRepoRoot;
        git_stash_list(path: String) -> Vec<GitStash>;
        git_remote_host(path: String) -> String;
        git_head_commit_url(path: String) -> Option<String>;
        git_graph_page(path: String, limit: u32, skip: u32) -> Vec<GraphCommit>;
        git_graph_refs(path: String) -> Vec<GraphRef>;
        git_commit_detail(path: String, sha: String) -> CommitDetail;
        git_commit_patch(path: String, sha: String) -> String;

        [WRITES] git_stage(path: String, files: Vec<String>) -> String;
        [WRITES] git_unstage(path: String, files: Vec<String>) -> String;
        [WRITES] git_discard(path: String, files: Vec<String>, untracked: bool) -> String;
        [WRITES] git_apply(path: String, patch: String, cached: bool, reverse: bool) -> String;
        [WRITES] git_apply_hunk(path: String, patch: String, file: String, hunk_index: usize, cached: bool, reverse: bool) -> String;
        [WRITES] git_commit(path: String, message: String) -> String;
        [WRITES] git_pull(path: String) -> String;
        [WRITES] git_push(path: String) -> String;
        [WRITES] git_push_to(path: String, remote: String, branch: String) -> String;
        [WRITES] git_commit_and_push(path: String, message: String, set_upstream: bool) -> CommitPush;
        [WRITES] git_checkout(path: String, branch: String, create: bool) -> String;
        [WRITES] git_branch_delete(path: String, branch: String) -> String;
        [WRITES] git_worktree_remove(path: String, worktree: String, force: bool) -> String;
        [WRITES] git_worktree_prune(path: String) -> String;
        [WRITES] git_stash_push(path: String, message: String) -> String;
        [WRITES] git_stash_apply(path: String, index: u32, pop: bool) -> String;
        [WRITES] git_stash_drop(path: String, index: u32) -> String;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_c_quoted_paths() {
        assert_eq!(unquote_path("src/a.ts"), "src/a.ts");
        assert_eq!(unquote_path("\"src/with space.ts\""), "src/with space.ts");
        assert_eq!(unquote_path("\"a\\\"b\""), "a\"b");
        assert_eq!(unquote_path("\"a\\\\b\""), "a\\b");
        assert_eq!(unquote_path("\"a\\tb\\nc\""), "a\tb\nc");
        // Octal escapes are raw bytes: this pair is the UTF-8 for "é".
        assert_eq!(unquote_path("\"caf\\303\\251.ts\""), "café.ts");
        // An unknown escape is left alone rather than swallowed.
        assert_eq!(unquote_path("\"a\\qb\""), "a\\qb");
        // Degenerate input must not panic.
        assert_eq!(unquote_path("\""), "\"");
        assert_eq!(unquote_path(""), "");
    }
}
