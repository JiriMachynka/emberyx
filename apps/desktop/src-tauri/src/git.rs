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
