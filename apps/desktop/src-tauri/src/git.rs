use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde::Serialize;

use crate::error::{Error, Result};

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
fn git(path: &str, args: &[&str]) -> Result<Output> {
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
fn failure(out: &Output) -> Error {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    Error::new(format!("{}{}", stdout, stderr).trim())
}

fn is_repo(path: &str) -> bool {
    git(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a git command in a repo, returning trimmed stdout on success or git's
/// own error message on failure.
fn run_git(path: &str, args: &[&str]) -> Result<String> {
    if !is_repo(path) {
        return Err(Error::new("Not a git repository."));
    }
    let out = git(path, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(failure(&out))
    }
}

/// List working-tree changes (staged, unstaged, untracked).
#[tauri::command]
pub fn git_changes(path: String) -> Result<Vec<GitFile>> {
    if !is_repo(&path) {
        return Ok(vec![]);
    }
    let out = git(&path, &["status", "--porcelain=v1"])?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut files = vec![];
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[0..2].to_string();
        let raw_path = &line[3..];
        // Renames appear as "old -> new"; show the new path.
        let raw_path = match raw_path.find(" -> ") {
            Some(idx) => &raw_path[idx + 4..],
            None => raw_path,
        };
        // Paths with spaces/unicode/control chars are C-quoted by git; unquote
        // so downstream commands (e.g. git_file_diff) get a real path.
        let path_part = unquote_path(raw_path);
        files.push(GitFile {
            untracked: status == "??",
            path: path_part,
            status,
        });
    }
    Ok(files)
}

/// Unified diff for one file: the index diff (`--cached`) when `staged`, else
/// what the working tree has on top of the index. Untracked files have no diff,
/// so their contents are rendered as one big addition.
#[tauri::command]
pub fn git_file_diff(
    path: String,
    file: String,
    untracked: bool,
    staged: bool,
) -> Result<String> {
    if untracked {
        let content =
            std::fs::read_to_string(Path::new(&path).join(&file)).unwrap_or_default();
        return Ok(content
            .lines()
            .map(|l| format!("+{}", l))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    let mut args = vec!["diff", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.extend_from_slice(&["--", &file]);
    let out = git(&path, &args)?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Add paths to the index (picks up untracked files too).
#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<String> {
    if files.is_empty() {
        return Err(Error::new("No files selected."));
    }
    let mut args = vec!["add", "--"];
    args.extend(files.iter().map(|f| f.as_str()));
    run_git(&path, &args)
}

/// Drop paths from the index, leaving the working tree untouched.
#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<String> {
    if files.is_empty() {
        return Err(Error::new("No files selected."));
    }
    // `reset` (not `restore --staged`) also handles a repo with no HEAD yet.
    let mut args = vec!["reset", "--quiet", "HEAD", "--"];
    args.extend(files.iter().map(|f| f.as_str()));
    run_git(&path, &args).or_else(|_| {
        let mut args = vec!["rm", "--cached", "--quiet", "--"];
        args.extend(files.iter().map(|f| f.as_str()));
        run_git(&path, &args)
    })
}

/// Throw away a file's changes: delete it when untracked, else restore it from
/// the index and HEAD. Irreversible — the caller confirms first.
#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>, untracked: bool) -> Result<String> {
    if files.is_empty() {
        return Err(Error::new("No files selected."));
    }
    if untracked {
        for file in &files {
            std::fs::remove_file(Path::new(&path).join(file))?;
        }
        return Ok(String::new());
    }
    let mut args = vec!["checkout", "HEAD", "--"];
    args.extend(files.iter().map(|f| f.as_str()));
    run_git(&path, &args)
}

/// Apply a unified-diff patch built by the frontend from one hunk of a file's
/// diff. `cached` targets the index (stage / unstage a hunk); `reverse` undoes
/// the hunk instead of applying it (unstage, or discard from the working tree).
#[tauri::command]
pub fn git_apply(path: String, patch: String, cached: bool, reverse: bool) -> Result<String> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    let mut args = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");

    let out = git_stdin(&path, &args, &patch)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(failure(&out))
    }
}

/// Commit whatever is staged in the index.
#[tauri::command]
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

/// One commit that touched a file, as shown on the history timeline.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Author date, ISO-8601.
    pub date: String,
    /// Author date relative to now, e.g. "3 days ago".
    pub relative_date: String,
    pub subject: String,
    /// The file's path at this commit — differs from the queried path once the
    /// walk crosses a rename.
    pub path: String,
    /// The path it was renamed from, when this commit did the renaming.
    pub old_path: Option<String>,
}

/// Field/record separators for `--pretty=format` — chosen because neither can
/// appear in a commit subject or author name.
const SEP: char = '\x1f';
const RECORD: char = '\x1e';

/// A file's history, newest first, following it across renames.
#[tauri::command]
pub fn git_file_log(path: String, file: String) -> Result<Vec<GitCommit>> {
    let fmt = format!(
        "{RECORD}%H{SEP}%h{SEP}%an{SEP}%aI{SEP}%ar{SEP}%s"
    );
    let out = run_git(
        &path,
        &[
            "log",
            "--follow",
            "--name-status",
            "-M",
            &format!("--pretty=format:{fmt}"),
            "--",
            &file,
        ],
    )?;

    let mut commits = vec![];
    for chunk in out.split(RECORD) {
        let chunk = chunk.trim_start_matches('\n');
        if chunk.is_empty() {
            continue;
        }
        let mut lines = chunk.lines();
        let Some(head) = lines.next() else { continue };
        let fields: Vec<&str> = head.split(SEP).collect();
        if fields.len() < 6 || fields[0].len() < 7 {
            continue;
        }

        // The name-status line after the header carries the path at this
        // commit, and both paths when it was a rename (R100 old new).
        let mut file_path = file.clone();
        let mut old_path = None;
        if let Some(status_line) = lines.find(|l| !l.is_empty()) {
            let parts: Vec<&str> = status_line.split('\t').collect();
            let status = parts.first().copied().unwrap_or("");
            if (status.starts_with('R') || status.starts_with('C')) && parts.len() >= 3 {
                old_path = Some(unquote_path(parts[1]));
                file_path = unquote_path(parts[2]);
            } else if parts.len() >= 2 {
                file_path = unquote_path(parts[1]);
            }
        }

        commits.push(GitCommit {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            author: fields[2].to_string(),
            date: fields[3].to_string(),
            relative_date: fields[4].to_string(),
            subject: fields[5].to_string(),
            path: file_path,
            old_path,
        });
    }
    Ok(commits)
}

/// A file's contents at one commit. Empty when the file didn't exist there.
#[tauri::command]
pub fn git_show_file(path: String, sha: String, file: String) -> Result<String> {
    let out = git(&path, &["show", &format!("{sha}:{file}")])?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Ok(String::new())
    }
}

/// Pickaxe search (`git log -S`): the shas of commits that added or removed
/// `term` in this file.
#[tauri::command]
pub fn git_pickaxe(path: String, file: String, term: String) -> Result<Vec<String>> {
    if term.trim().is_empty() {
        return Ok(vec![]);
    }
    let out = run_git(
        &path,
        &[
            "log",
            "--follow",
            "--pretty=format:%H",
            &format!("-S{term}"),
            "--",
            &file,
        ],
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

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
#[tauri::command]
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

/// Local branch names.
#[tauri::command]
pub fn git_branches(path: String) -> Result<Vec<String>> {
    let out = run_git(&path, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// Fetch and merge from the tracked remote.
#[tauri::command]
pub fn git_pull(path: String) -> Result<String> {
    run_git(&path, &["pull"])
}

/// Push the current branch to its configured upstream.
#[tauri::command]
pub fn git_push(path: String) -> Result<String> {
    run_git(&path, &["push"])
}

/// Push `branch` to `remote` and set it as the upstream.
#[tauri::command]
pub fn git_push_to(path: String, remote: String, branch: String) -> Result<String> {
    run_git(&path, &["push", "-u", &remote, &branch])
}

/// Switch to `branch`, creating it (`-b`) when `create` is set.
#[tauri::command]
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
#[tauri::command]
pub fn git_branch_delete(path: String, branch: String) -> Result<String> {
    if branch.trim().is_empty() {
        return Err(Error::new("Branch name is empty."));
    }
    run_git(&path, &["branch", "-d", &branch])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    /// Stash position (0 = most recent), used as `stash@{index}`.
    pub index: u32,
    /// Full description line from `git stash list`.
    pub label: String,
}

/// Stash all working-tree changes, with an optional message.
#[tauri::command]
pub fn git_stash_push(path: String, message: String) -> Result<String> {
    if message.trim().is_empty() {
        run_git(&path, &["stash", "push"])
    } else {
        run_git(&path, &["stash", "push", "-m", message.trim()])
    }
}

/// List saved stashes, newest first.
#[tauri::command]
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
#[tauri::command]
pub fn git_stash_apply(path: String, index: u32, pop: bool) -> Result<String> {
    let stash = format!("stash@{{{}}}", index);
    let action = if pop { "pop" } else { "apply" };
    run_git(&path, &["stash", action, &stash])
}

/// Discard the stash at `index` without applying it.
#[tauri::command]
pub fn git_stash_drop(path: String, index: u32) -> Result<String> {
    let stash = format!("stash@{{{}}}", index);
    run_git(&path, &["stash", "drop", &stash])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repo with deterministic identity and no global config
    /// leaking in (signing, hooks, and templates all vary per machine).
    struct Repo(std::path::PathBuf);

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("emberyx_test_git_{name}"));
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

        /// Raw git, for arranging state the module under test isn't asserting on.
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
            let path = self.0.join(file);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, contents).unwrap();
        }

        fn commit(&self, message: &str) {
            self.run(&["add", "-A"]);
            self.run(&["commit", "-m", message]);
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn status_of(files: &[GitFile], path: &str) -> String {
        files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} not in {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>()))
            .status
            .clone()
    }

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

    #[test]
    fn reports_nothing_outside_a_repo() {
        let dir = std::env::temp_dir().join("emberyx_test_git_not_a_repo");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        assert!(git_changes(path.clone()).unwrap().is_empty());
        assert!(git_commit(path.clone(), "msg".into()).is_err());
        assert!(git_apply(path, String::new(), false, false).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_untracked_staged_and_modified_files() {
        let repo = Repo::new("status");
        repo.write("tracked.txt", "one\n");
        repo.commit("init");

        repo.write("tracked.txt", "two\n");
        repo.write("fresh.txt", "new\n");
        repo.write("staged.txt", "staged\n");
        repo.run(&["add", "staged.txt"]);

        let files = git_changes(repo.path()).unwrap();
        assert_eq!(status_of(&files, "tracked.txt"), " M");
        assert_eq!(status_of(&files, "fresh.txt"), "??");
        assert_eq!(status_of(&files, "staged.txt"), "A ");
        assert!(files.iter().find(|f| f.path == "fresh.txt").unwrap().untracked);
        assert!(!files.iter().find(|f| f.path == "tracked.txt").unwrap().untracked);
    }

    #[test]
    fn reports_the_new_path_of_a_rename() {
        let repo = Repo::new("rename");
        repo.write("old.txt", "contents\n");
        repo.commit("init");
        repo.run(&["mv", "old.txt", "new.txt"]);

        let files = git_changes(repo.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.txt");
        assert!(files[0].status.starts_with('R'));
    }

    #[test]
    fn unquotes_paths_with_spaces_from_status() {
        let repo = Repo::new("quoted");
        repo.write("a file with spaces.txt", "x\n");

        let files = git_changes(repo.path()).unwrap();
        assert_eq!(files[0].path, "a file with spaces.txt");
        // The unquoted path must be usable as-is by the follow-up diff call.
        let diff = git_file_diff(repo.path(), files[0].path.clone(), true, false).unwrap();
        assert_eq!(diff, "+x");
    }

    #[test]
    fn renders_an_untracked_file_as_one_big_addition() {
        let repo = Repo::new("untracked_diff");
        repo.write("new.txt", "one\ntwo\n");
        let diff = git_file_diff(repo.path(), "new.txt".into(), true, false).unwrap();
        assert_eq!(diff, "+one\n+two");
    }

    #[test]
    fn diffs_the_working_tree_and_the_index_separately() {
        let repo = Repo::new("diff_staged");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        repo.write("a.txt", "two\n");
        repo.run(&["add", "a.txt"]);
        repo.write("a.txt", "three\n");

        let staged = git_file_diff(repo.path(), "a.txt".into(), false, true).unwrap();
        assert!(staged.contains("+two") && !staged.contains("+three"));

        let unstaged = git_file_diff(repo.path(), "a.txt".into(), false, false).unwrap();
        assert!(unstaged.contains("+three") && unstaged.contains("-two"));
    }

    #[test]
    fn stages_unstages_and_commits() {
        let repo = Repo::new("stage_commit");
        repo.write("a.txt", "one\n");

        git_stage(repo.path(), vec!["a.txt".into()]).unwrap();
        assert_eq!(status_of(&git_changes(repo.path()).unwrap(), "a.txt"), "A ");

        // Unstaging a never-committed file falls back to `rm --cached`.
        git_unstage(repo.path(), vec!["a.txt".into()]).unwrap();
        assert_eq!(status_of(&git_changes(repo.path()).unwrap(), "a.txt"), "??");

        git_stage(repo.path(), vec!["a.txt".into()]).unwrap();
        git_commit(repo.path(), "feat: add a".into()).unwrap();
        assert!(git_changes(repo.path()).unwrap().is_empty());
        assert_eq!(repo.run(&["log", "-1", "--pretty=%s"]), "feat: add a");
    }

    #[test]
    fn refuses_empty_selections_and_empty_messages() {
        let repo = Repo::new("guards");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        assert!(git_stage(repo.path(), vec![]).is_err());
        assert!(git_unstage(repo.path(), vec![]).is_err());
        assert!(git_discard(repo.path(), vec![], false).is_err());
        assert!(git_commit(repo.path(), "   ".into()).is_err());
        assert!(git_checkout(repo.path(), "  ".into(), false).is_err());
        assert!(git_branch_delete(repo.path(), "".into()).is_err());
    }

    #[test]
    fn discards_tracked_edits_and_deletes_untracked_files() {
        let repo = Repo::new("discard");
        repo.write("tracked.txt", "original\n");
        repo.commit("init");
        repo.write("tracked.txt", "edited\n");
        repo.write("junk.txt", "junk\n");

        git_discard(repo.path(), vec!["tracked.txt".into()], false).unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "original\n"
        );

        git_discard(repo.path(), vec!["junk.txt".into()], true).unwrap();
        assert!(!repo.0.join("junk.txt").exists());
    }

    #[test]
    fn applies_and_reverses_a_single_hunk_against_the_index() {
        let repo = Repo::new("apply");
        repo.write("a.txt", "one\ntwo\n");
        repo.commit("init");

        let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n";
        git_apply(repo.path(), patch.to_string(), true, false).unwrap();

        // Staged in the index; the working tree still holds the original.
        let staged = git_file_diff(repo.path(), "a.txt".into(), false, true).unwrap();
        assert!(staged.contains("+ONE"));
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );

        git_apply(repo.path(), patch.to_string(), true, true).unwrap();
        assert!(git_changes(repo.path()).unwrap().is_empty());
    }

    #[test]
    fn surfaces_gits_own_message_when_a_patch_does_not_apply() {
        let repo = Repo::new("apply_fail");
        repo.write("a.txt", "one\n");
        repo.commit("init");

        let patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nonexistent\n+x\n";
        let err = git_apply(repo.path(), patch.into(), false, false).unwrap_err();
        assert!(
            err.to_string().contains("patch does not apply")
                || err.to_string().contains("error"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn follows_a_file_across_a_rename_in_its_history() {
        let repo = Repo::new("log");
        repo.write("old.txt", "one\n");
        repo.commit("feat: add old");
        repo.run(&["mv", "old.txt", "new.txt"]);
        repo.commit("refactor: rename to new");
        repo.write("new.txt", "one\ntwo\n");
        repo.commit("feat: extend new");

        let log = git_file_log(repo.path(), "new.txt".into()).unwrap();
        assert_eq!(
            log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            vec!["feat: extend new", "refactor: rename to new", "feat: add old"]
        );
        assert_eq!(log[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(log[1].path, "new.txt");
        assert!(log[0].old_path.is_none());

        // Every commit carries the identity fields the timeline renders.
        for commit in &log {
            assert_eq!(commit.sha.len(), 40);
            assert!(commit.sha.starts_with(&commit.short_sha));
            assert_eq!(commit.author, "Emberyx Test");
            assert!(commit.date.starts_with("20"));
            assert!(!commit.relative_date.is_empty());
        }
    }

    #[test]
    fn reads_a_file_at_a_commit_and_empty_where_it_is_absent() {
        let repo = Repo::new("show");
        repo.write("a.txt", "first\n");
        repo.commit("one");
        let first = repo.run(&["rev-parse", "HEAD"]);
        repo.write("a.txt", "second\n");
        repo.commit("two");

        assert_eq!(
            git_show_file(repo.path(), first.clone(), "a.txt".into()).unwrap(),
            "first\n"
        );
        assert_eq!(
            git_show_file(repo.path(), first, "missing.txt".into()).unwrap(),
            ""
        );
    }

    #[test]
    fn pickaxes_the_commits_that_touched_a_term() {
        let repo = Repo::new("pickaxe");
        repo.write("a.txt", "hello\n");
        repo.commit("one");
        repo.write("a.txt", "hello\nNEEDLE\n");
        repo.commit("two");
        let needle_sha = repo.run(&["rev-parse", "HEAD"]);
        repo.write("a.txt", "hello\nNEEDLE\nmore\n");
        repo.commit("three");

        let hits = git_pickaxe(repo.path(), "a.txt".into(), "NEEDLE".into()).unwrap();
        assert_eq!(hits, vec![needle_sha]);

        assert!(git_pickaxe(repo.path(), "a.txt".into(), "  ".into())
            .unwrap()
            .is_empty());
    }

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
    fn refuses_to_delete_a_branch_with_unmerged_work() {
        let repo = Repo::new("branch_unmerged");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        git_checkout(repo.path(), "feature".into(), true).unwrap();
        repo.write("b.txt", "work\n");
        repo.commit("feature work");
        git_checkout(repo.path(), "main".into(), false).unwrap();

        assert!(git_branch_delete(repo.path(), "feature".into()).is_err());
        assert!(git_branches(repo.path()).unwrap().contains(&"feature".to_string()));
    }

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
