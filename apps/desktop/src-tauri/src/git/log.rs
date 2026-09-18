use serde::Serialize;

use super::{failure, git, is_repo, run_git, unquote_path};
use crate::error::{Error, Result};

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
pub fn git_file_log(path: String, file: String) -> Result<Vec<GitCommit>> {
    let fmt = format!("{RECORD}%H{SEP}%h{SEP}%an{SEP}%aI{SEP}%ar{SEP}%s");
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
pub(super) fn parse_name_status(rest: &str) -> Vec<GitCommitFile> {
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
pub fn git_log(path: String, limit: u32) -> Result<Vec<GitLogEntry>> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    let fmt = format!("{RECORD}%H{SEP}%h{SEP}%s{SEP}%an{SEP}%ar{SEP}%P{SEP}%D");
    let pretty = format!("--pretty=format:{fmt}");
    let n = format!("-n{limit}");
    // `git log --name-status` prints nothing for a merge, so a merge row in the
    // history had no files to unfold. `--diff-merges=first-parent` gives it the
    // changes the merge brought in — what a forge calls the merge's files.
    // Retried without the flag for gits too old to know it (< 2.31): merges
    // list nothing there, which is the old behaviour rather than no history.
    let args = [
        "log",
        &n,
        "--name-status",
        "--diff-merges=first-parent",
        "-M",
        "-z",
        &pretty,
        "HEAD",
    ];
    let mut out = git(&path, &args)?;
    if !out.status.success() {
        out = git(
            &path,
            &["log", &n, "--name-status", "-M", "-z", &pretty, "HEAD"],
        )?;
    }
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
pub fn git_commit_diff(path: String, sha: String, file: String) -> Result<String> {
    // Same first-parent view the log lists a merge's files from, or picking one
    // of those files would open an empty diff.
    let out = git(
        &path,
        &[
            "show",
            "--no-color",
            "--diff-merges=first-parent",
            "--format=",
            &sha,
            "--",
            &file,
        ],
    )?;
    if !out.status.success() {
        let plain = git(
            &path,
            &["show", "--no-color", "--format=", &sha, "--", &file],
        )?;
        return Ok(String::from_utf8_lossy(&plain.stdout).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Pickaxe search (`git log -S`): the shas of commits that added or removed
/// `term` in this file.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::Repo;

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
        assert!(log[0]
            .files
            .iter()
            .any(|f| f.status == "A" && f.path == "b.txt"));
        assert_eq!(log[1].files.len(), 1);
        assert_eq!(log[1].files[0].status, "A");
        assert_eq!(log[1].files[0].path, "a.txt");
    }

    #[test]
    fn lists_what_a_merge_brought_in() {
        let repo = Repo::new("repo_log_merge");
        repo.write("base.txt", "base\n");
        repo.commit("first");
        repo.run(&["checkout", "-b", "side"]);
        repo.write("side.txt", "from the branch\n");
        repo.commit("side work");
        repo.run(&["checkout", "-"]);
        repo.write("main.txt", "on main\n");
        repo.commit("main work");
        repo.run(&["merge", "--no-ff", "-m", "merge side", "side"]);

        let log = git_log(repo.path(), 10).unwrap();
        let merge = log.iter().find(|c| c.subject == "merge side").unwrap();
        assert!(merge.parents.len() > 1, "the commit under test is a merge");
        // Plain --name-status prints nothing for a merge, which left the row
        // unfoldable. First-parent diff-merges is what gives it the file.
        assert!(merge.files.iter().any(|f| f.path == "side.txt"));

        let diff = git_commit_diff(repo.path(), merge.sha.clone(), "side.txt".into()).unwrap();
        assert!(
            diff.contains("from the branch"),
            "merge file opens a real diff"
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
            vec![
                "feat: extend new",
                "refactor: rename to new",
                "feat: add old"
            ]
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
}
