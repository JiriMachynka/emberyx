use std::io::Write;
use std::path::{Path, PathBuf};
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
pub(crate) fn run_git(path: &str, args: &[&str]) -> Result<String> {
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
/// so their contents are rendered as one big addition. `ignore_whitespace`
/// passes `-w`, the diff viewer's "hide whitespace changes" toggle.
#[tauri::command]
pub fn git_file_diff(
    path: String,
    file: String,
    untracked: bool,
    staged: bool,
    ignore_whitespace: Option<bool>,
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
    if ignore_whitespace.unwrap_or(false) {
        args.push("-w");
    }
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
pub async fn git_draft_commit_message(path: String, model: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let diff = commit_diff(&path)?;
        if diff.trim().is_empty() {
            return Err(Error::new("Nothing to describe — no changes."));
        }
        let prompt = format!(
            "Write the git commit message for this change.\n\n\
             - First line: what changed, in plain language and the imperative, \
             at most 72 characters, no trailing period.\n\
             - Add a short body only when the change needs a why. Otherwise \
             reply with the subject line alone.\n\
             - Write it the way a person would. No file-by-file inventory, no \
             Conventional Commit prefix, no bullet padding.\n\
             - Reply with the message only: no quotes, no code fences, no \
             preamble.\n\nDiff:\n{}",
            truncate_diff(&diff, DRAFT_DIFF_LIMIT)
        );
        let raw = crate::agent::AgentManager::one_shot(&prompt, &model)?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    /// Single-letter status: M, A, D, R, C, T.
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    /// Author date relative to now, e.g. "3 days ago".
    pub relative_date: String,
    pub parents: Vec<String>,
    /// Ref decorations from %D, e.g. ["HEAD -> main", "origin/main", "tag: v1"].
    pub refs: Vec<String>,
    pub files: Vec<GitCommitFile>,
}

/// Parse the `-z` `--name-status` payload: NUL-separated tokens where a status
/// code is followed by one path (two, for renames/copies).
fn parse_name_status(rest: &str) -> Vec<GitCommitFile> {
    let toks: Vec<&str> = rest.split('\0').filter(|t| !t.trim().is_empty()).collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let code = toks[i].chars().next().unwrap_or(' ');
        if code == 'R' || code == 'C' {
            if i + 2 >= toks.len() {
                break;
            }
            files.push(GitCommitFile {
                status: code.to_string(),
                old_path: Some(toks[i + 1].to_string()),
                path: toks[i + 2].to_string(),
            });
            i += 3;
        } else {
            if i + 1 >= toks.len() {
                break;
            }
            files.push(GitCommitFile {
                status: code.to_string(),
                old_path: None,
                path: toks[i + 1].to_string(),
            });
            i += 2;
        }
    }
    files
}

/// Repo-wide history, newest first, one page of `limit` commits, each with the
/// files it changed. Pagination grows `limit` from the frontend — no cursor.
#[tauri::command]
pub fn git_log(path: String, limit: u32) -> Result<Vec<GitLogEntry>> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    let fmt = format!("{RECORD}%H{SEP}%h{SEP}%s{SEP}%an{SEP}%ar{SEP}%P{SEP}%D");
    let pretty = format!("--pretty=format:{fmt}");
    let n = format!("-n{limit}");
    let args = ["log", &n, "--name-status", "-M", "-z", &pretty, "HEAD"];
    let out = git(&path, &args)?;
    if !out.status.success() {
        return Err(failure(&out));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut entries = Vec::new();
    for chunk in text.split(RECORD) {
        if chunk.is_empty() {
            continue;
        }
        // git terminates the pretty-format header with a newline, then lists
        // the -z name-status entries (NUL-separated) after it.
        let mut halves = chunk.splitn(2, '\n');
        let Some(header) = halves.next() else {
            continue;
        };
        let rest = halves.next().unwrap_or("");
        let fields: Vec<&str> = header.split(SEP).collect();
        if fields.len() < 7 {
            continue;
        }
        let parents = fields[5].split_whitespace().map(str::to_string).collect();
        let refs = fields[6]
            .split(", ")
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .collect();
        entries.push(GitLogEntry {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            subject: fields[2].to_string(),
            author: fields[3].to_string(),
            relative_date: fields[4].to_string(),
            parents,
            refs,
            files: parse_name_status(rest),
        });
    }
    Ok(entries)
}

/// The diff one commit introduced to one file (vs its first parent).
#[tauri::command]
pub fn git_commit_diff(path: String, sha: String, file: String) -> Result<String> {
    let out = git(&path, &["show", "--no-color", "--format=", &sha, "--", &file])?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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

/// The branch a repo's work merges back into: the remote's own default when it
/// publishes one, else the first conventional name that actually resolves.
/// Returning None means "can't tell", which callers must treat as "nothing is
/// merged" — claiming a branch was merged when it wasn't hides live work.
fn merge_base_ref(path: &str) -> Option<String> {
    if let Ok(head) = run_git(
        path,
        &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
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
#[tauri::command]
pub fn git_default_branch(path: String) -> Result<Option<String>> {
    Ok(merge_base_ref(&path).map(|base| base.rsplit('/').next().unwrap_or(&base).to_string()))
}

/// Local branches already merged into the repo's default branch, which the
/// sidebar reads as "this thread's work is done". One call per repo root, not
/// one per thread. The base itself is always reachable from itself, so it is
/// dropped — a repo sitting on `main` is not a pile of finished work.
#[tauri::command]
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

/// Parent exists (created if needed) and `dest` is missing or an empty
/// directory, so `git clone` has somewhere to land.
pub(crate) fn prepare_clone_destination(dest: &Path) -> Result<()> {
    if dest.as_os_str().is_empty() {
        return Err(Error::new("Choose a destination path before cloning."));
    }
    if dest.exists() {
        if !dest.is_dir() {
            return Err(Error::new("Destination exists and is not a directory."));
        }
        if dest.read_dir()?.next().is_some() {
            return Err(Error::new("Destination already exists and is not empty."));
        }
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

fn clone_into(url: String, destination: String) -> Result<String> {
    let dest = PathBuf::from(destination.trim());
    prepare_clone_destination(&dest)?;
    let parent = dest.parent().ok_or_else(|| Error::new("Destination has no parent directory."))?;
    let name = dest
        .file_name()
        .ok_or_else(|| Error::new("Destination has no directory name."))?
        .to_string_lossy()
        .into_owned();
    let out = Command::new("git")
        .current_dir(parent)
        .args(["clone", "--", url.trim(), &name])
        .output()?;
    if out.status.success() {
        Ok(dest.to_string_lossy().to_string())
    } else {
        Err(failure(&out))
    }
}

/// Clone `url` into `destination`. The last path segment is the new folder.
#[tauri::command]
pub async fn git_clone(url: String, destination: String) -> Result<String> {
    Ok(
        tauri::async_runtime::spawn_blocking(move || clone_into(url, destination))
            .await
            .map_err(|e| e.to_string())??,
    )
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
#[tauri::command]
pub fn git_commit_and_push(path: String, message: String, set_upstream: bool) -> Result<CommitPush> {
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
                    wt.branch = value.strip_prefix("refs/heads/").unwrap_or(value).to_string();
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

fn branch_exists(path: &str, branch: &str) -> bool {
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
#[tauri::command]
pub fn git_worktrees(path: String) -> Result<Vec<GitWorktree>> {
    if !is_repo(&path) {
        return Ok(vec![]);
    }
    let out = git(&path, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_list(&String::from_utf8_lossy(&out.stdout)))
}

/// Which repo (and which of its worktrees) a path belongs to.
#[tauri::command]
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
    Ok(
        tauri::async_runtime::spawn_blocking(move || worktree_add(path, branch, create, base))
            .await
            .map_err(|e| e.to_string())??,
    )
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
#[tauri::command]
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
#[tauri::command]
pub fn git_worktree_prune(path: String) -> Result<String> {
    run_git(&path, &["worktree", "prune"])
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
    if !rel
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))
    {
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
    Ok(tauri::async_runtime::spawn_blocking(move || fetch(path, remote))
        .await
        .map_err(|e| e.to_string())??)
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
    Ok(
        tauri::async_runtime::spawn_blocking(move || checkout_remote(path, branch, remote))
            .await
            .map_err(|e| e.to_string())??,
    )
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
    Ok(
        tauri::async_runtime::spawn_blocking(move || merge(path, git_ref))
            .await
            .map_err(|e| e.to_string())??,
    )
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
    Ok(
        tauri::async_runtime::spawn_blocking(move || conflicted_files(&path))
            .await
            .map_err(|e| e.to_string())??,
    )
}

/// The three sides of one conflicted file plus the marked-up working copy.
#[tauri::command]
pub async fn git_conflict_stages(path: String, file: String) -> Result<ConflictStages> {
    Ok(
        tauri::async_runtime::spawn_blocking(move || conflict_stages(path, file))
            .await
            .map_err(|e| e.to_string())??,
    )
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
    Ok(
        tauri::async_runtime::spawn_blocking(move || resolve(path, file, content))
            .await
            .map_err(|e| e.to_string())??,
    )
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
    Ok(tauri::async_runtime::spawn_blocking(move || {
        run_git(&path, &["merge", "--abort"]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())??)
}

/// Commit the merge once every conflict is staged.
#[tauri::command]
pub async fn git_merge_continue(path: String, message: Option<String>) -> Result<()> {
    Ok(
        tauri::async_runtime::spawn_blocking(move || merge_continue(path, message))
            .await
            .map_err(|e| e.to_string())??,
    )
}

fn merge_continue(path: String, message: Option<String>) -> Result<()> {
    if !conflicted_files(&path)?.is_empty() {
        return Err(Error::new("Resolve the remaining conflicts first."));
    }
    let message = message.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
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
    Ok(tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())??)
}

/// `remote.origin.url` for the repo at `cwd`, if it has one.
fn remote_url(cwd: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", cwd, "config", "--get", "remote.origin.url"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Bare, lowercased host of a git remote URL (`github.com`,
/// `gitlab.example.com`, …). Handles `scheme://host/…` and scp-form
/// `git@host:owner/repo`, stripping any credentials and port.
fn parse_remote_host(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    let authority = if let Some(idx) = s.find("://") {
        s[idx + 3..].split('/').next()?
    } else {
        s.split(':').next()?
    };
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Classify the origin remote's host as `"github" | "gitlab" | "other"`.
/// Returns `"other"` when there is no remote or the host is neither. A
/// self-hosted GitLab on a custom domain reads as `"other"` — known limitation.
#[tauri::command]
pub fn git_remote_host(path: String) -> Result<String> {
    let host = match remote_url(&path).as_deref().and_then(parse_remote_host) {
        Some(h) => h,
        None => return Ok("other".into()),
    };
    let kind = if host.contains("github") {
        "github"
    } else if host.contains("gitlab") {
        "gitlab"
    } else {
        "other"
    };
    Ok(kind.into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(cut.lines().all(|l| l.is_empty()
            || l.starts_with("+line")
            || l.starts_with("[diff truncated")));
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
            // Worktrees land beside the repo, not inside it, so clear this
            // repo's own entries too — the `.emberyx-worktrees` root is shared
            // by every test running in parallel.
            if let (Some(parent), Some(name)) = (self.0.parent(), self.0.file_name()) {
                let prefix = format!("{}-", name.to_string_lossy());
                if let Ok(entries) = std::fs::read_dir(parent.join(".emberyx-worktrees")) {
                    for entry in entries.flatten() {
                        if entry.file_name().to_string_lossy().starts_with(&prefix) {
                            let _ = std::fs::remove_dir_all(entry.path());
                        }
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Drive the async worktree command from a sync test.
    fn add_worktree(repo: &Repo, branch: &str, create: bool) -> Result<String> {
        tauri::async_runtime::block_on(git_worktree_add(
            repo.path(),
            branch.to_string(),
            create,
            None,
        ))
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
    fn prepare_clone_destination_accepts_missing_or_empty() {
        let dest = std::env::temp_dir().join(format!(
            "emberyx_test_git_clone_empty_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dest);
        prepare_clone_destination(&dest).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        prepare_clone_destination(&dest).unwrap();
        std::fs::write(dest.join("x"), "y").unwrap();
        assert!(prepare_clone_destination(&dest).is_err());
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn clones_a_local_repo() {
        let src = Repo::new("clone_src");
        src.write("a.txt", "hi");
        src.commit("init");
        let dest = std::env::temp_dir().join(format!(
            "emberyx_test_git_clone_dest_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dest);
        clone_into(src.path(), dest.to_string_lossy().to_string()).unwrap();
        assert!(dest.join(".git").is_dir());
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "hi");
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn parses_the_remote_host() {
        assert_eq!(
            parse_remote_host("https://github.com/owner/repo.git").as_deref(),
            Some("github.com")
        );
        // scp-form.
        assert_eq!(
            parse_remote_host("git@github.com:owner/repo.git").as_deref(),
            Some("github.com")
        );
        // Nested groups + credentials + port.
        assert_eq!(
            parse_remote_host("https://user@gitlab.com:443/group/sub/repo.git").as_deref(),
            Some("gitlab.com")
        );
        // Self-hosted host survives verbatim (classified as "other" upstream).
        assert_eq!(
            parse_remote_host("git@gitlab.example.com:g/r.git").as_deref(),
            Some("gitlab.example.com")
        );
        assert_eq!(parse_remote_host(""), None);
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
    fn logs_repo_history_newest_first_with_changed_files() {
        let repo = Repo::new("repo_log");
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.commit("first");
        // Rename with no content change, so git reports it as R (not D+A).
        repo.write("b.txt", "new\n");
        repo.run(&["add", "b.txt"]);
        repo.run(&["mv", "a.txt", "renamed.txt"]);
        repo.commit("second");

        let log = git_log(repo.path(), 10).unwrap();
        assert_eq!(log.len(), 2);
        // Newest first.
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[1].subject, "first");

        let rename = log[0]
            .files
            .iter()
            .find(|f| f.status.starts_with('R'))
            .expect("rename present");
        assert_eq!(rename.old_path.as_deref(), Some("a.txt"));
        assert_eq!(rename.path, "renamed.txt");
        assert!(log[0].files.iter().any(|f| f.status == "A" && f.path == "b.txt"));
        assert_eq!(log[1].files.len(), 1);
        assert_eq!(log[1].files[0].status, "A");
        assert_eq!(log[1].files[0].path, "a.txt");
    }

    #[test]
    fn unquotes_paths_with_spaces_from_status() {
        let repo = Repo::new("quoted");
        repo.write("a file with spaces.txt", "x\n");

        let files = git_changes(repo.path()).unwrap();
        assert_eq!(files[0].path, "a file with spaces.txt");
        // The unquoted path must be usable as-is by the follow-up diff call.
        let diff = git_file_diff(repo.path(), files[0].path.clone(), true, false, None).unwrap();
        assert_eq!(diff, "+x");
    }

    #[test]
    fn renders_an_untracked_file_as_one_big_addition() {
        let repo = Repo::new("untracked_diff");
        repo.write("new.txt", "one\ntwo\n");
        let diff = git_file_diff(repo.path(), "new.txt".into(), true, false, None).unwrap();
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

        let staged = git_file_diff(repo.path(), "a.txt".into(), false, true, None).unwrap();
        assert!(staged.contains("+two") && !staged.contains("+three"));

        let unstaged = git_file_diff(repo.path(), "a.txt".into(), false, false, None).unwrap();
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
        let staged = git_file_diff(repo.path(), "a.txt".into(), false, true, None).unwrap();
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
        assert!(remote.run(&["log", "-1", "--pretty=%s", "main"]).contains("add a"));
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
        assert!(remote.run(&["log", "-1", "--pretty=%s", "feature"]).contains("feature work"));
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

        assert_eq!(git_merged_branches(repo.path()).unwrap(), Vec::<String>::new());
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
        assert!(dir.ends_with("emberyx_test_git_wt_add-feat-wt-add"));
        assert_eq!(std::fs::read_to_string(path.join("a.txt")).unwrap(), "one\n");

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
        assert_eq!(canonical(std::path::Path::new(&first)), canonical(std::path::Path::new(&second)));
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
        assert!(err.to_string().contains("main worktree"), "unexpected error: {err}");
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

        let stages = tauri::async_runtime::block_on(git_conflict_stages(
            repo.path(),
            "a.txt".to_string(),
        ))
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
        assert_eq!(repo.run(&["log", "-1", "--pretty=%s"]), "chore: merge feature");
    }

    #[test]
    fn resolve_refuses_paths_outside_the_repo() {
        let repo = Repo::new("resolve_escape");
        repo.write("a.txt", "one\n");
        repo.commit("init");
        let escape = repo.0.parent().unwrap().join("emberyx_test_git_escaped.txt");
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
        assert_eq!(status_of(&git_changes(repo.path()).unwrap(), "src/a.txt"), "M ");
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

        assert!(tauri::async_runtime::block_on(git_fetch(repo.path(), Some("nope".into()))).is_err());
    }
}
