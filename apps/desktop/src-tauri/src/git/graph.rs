use serde::Serialize;

use super::{failure, git, is_repo, run_git, GitCommitFile};
use crate::error::{Error, Result};

/// Field/record separators for `--pretty=format` — chosen because neither can
/// appear in a commit subject, author name, or ref decoration.
const SEP: char = '\x1f';
const RECORD: char = '\x1e';

/// One commit in the repo-wide history graph, across every ref.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    /// Author date, ISO-8601 — real, for tooltips and stable sorting.
    pub author_date: String,
    /// Author date relative to now, e.g. "3 days ago".
    pub relative_date: String,
    pub parents: Vec<String>,
    /// Ref decorations from %D, e.g. ["HEAD -> main", "tag: v1", "origin/main"].
    pub refs: Vec<String>,
}

/// One page of the history graph, newest first, across all refs.
///
/// Deliberately no `--name-status`: the changed-file list is the single
/// biggest cost at 50k commits and the lanes only need shas, parents, and the
/// ref decoration. `--date-order` guarantees a parent is listed after all its
/// children, which is what the lane layout relies on. `--skip` composes with
/// `-n` (skip is applied first), so pages can be laid out incrementally.
pub fn git_graph_page(path: String, limit: u32, skip: u32) -> Result<Vec<GraphCommit>> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    if limit == 0 {
        return Ok(vec![]);
    }
    let fmt = format!("{RECORD}%H{SEP}%h{SEP}%s{SEP}%an{SEP}%aI{SEP}%ar{SEP}%P{SEP}%D");
    let out = run_git(
        &path,
        &[
            "log",
            "--all",
            "--date-order",
            &format!("-n{limit}"),
            &format!("--skip={skip}"),
            &format!("--pretty=format:{fmt}"),
        ],
    )?;

    let mut commits = Vec::new();
    for chunk in out.split(RECORD) {
        let chunk = chunk.trim_start_matches('\n');
        if chunk.is_empty() {
            continue;
        }
        let fields: Vec<&str> = chunk.split(SEP).collect();
        if fields.len() < 8 {
            continue;
        }
        commits.push(GraphCommit {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            subject: fields[2].to_string(),
            author: fields[3].to_string(),
            author_date: fields[4].to_string(),
            relative_date: fields[5].to_string(),
            parents: fields[6].split_whitespace().map(str::to_string).collect(),
            refs: fields[7]
                .split(", ")
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string)
                .collect(),
        });
    }
    Ok(commits)
}

/// A branch, tag, or remote ref, resolved to the commit it points at.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    /// Full refname, e.g. "refs/heads/main".
    pub name: String,
    /// Short name, e.g. "main", "v1", "origin/main".
    pub short_name: String,
    /// "branch" | "tag" | "remote".
    pub kind: String,
    /// The commit sha the ref (peeled for annotated tags) targets.
    pub target_sha: String,
    pub is_head: bool,
    /// Tracking branch short name (e.g. "origin/main"), when configured.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// Parse `%(upstream:track)` output — "[ahead 1]", "[behind 2]",
/// "[ahead 1, behind 2]", "[gone]", or "" — into a head-behind pair.
fn parse_track(raw: &str) -> (u32, u32) {
    let inner = raw.trim().trim_start_matches('[').trim_end_matches(']');
    if inner.is_empty() || inner == "gone" {
        return (0, 0);
    }
    let mut ahead = 0;
    let mut behind = 0;
    for part in inner.split(',') {
        let mut words = part.split_whitespace();
        let (Some(word), Some(count)) = (words.next(), words.next()) else {
            continue;
        };
        let count = count.parse::<u32>().unwrap_or(0);
        if word == "ahead" {
            ahead = count;
        } else if word == "behind" {
            behind = count;
        }
    }
    (ahead, behind)
}

/// Every branch, tag, and remote ref, as rows for the graph's ref legend and
/// ref badges. `for-each-ref` reads the whole set in one call; the tracked
/// ahead/behind counts ride in the same call (`%(upstream:track)`), so they
/// cost no second git invocation.
pub fn git_graph_refs(path: String) -> Result<Vec<GraphRef>> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    let fmt = format!(
        "%(refname){SEP}%(refname:short){SEP}%(objecttype){SEP}%(objectname){SEP}%(*objectname){SEP}%(HEAD){SEP}%(upstream:short){SEP}%(upstream:track){RECORD}"
    );
    let out = run_git(
        &path,
        &[
            "for-each-ref",
            &format!("--format={fmt}"),
            "refs/heads",
            "refs/tags",
            "refs/remotes",
        ],
    )?;

    let mut refs = Vec::new();
    for record in out.split(RECORD) {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split(SEP).collect();
        if fields.len() < 8 {
            continue;
        }
        let name = fields[0];
        // Peel annotated tags to the commit they point at; a ref whose target
        // resolves to nothing commit-ish (a tag on a blob) has no graph row.
        let target = if fields[4].is_empty() {
            fields[3]
        } else {
            fields[4]
        };
        if target.is_empty() || !target.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let kind = if name.starts_with("refs/tags/") {
            "tag"
        } else if name.starts_with("refs/remotes/") {
            "remote"
        } else {
            "branch"
        };
        let (ahead, behind) = parse_track(fields[7]);
        refs.push(GraphRef {
            name: name.to_string(),
            short_name: fields[1].to_string(),
            kind: kind.to_string(),
            target_sha: target.to_string(),
            is_head: fields[5] == "*",
            upstream: if fields[6].is_empty() {
                None
            } else {
                Some(fields[6].to_string())
            },
            ahead,
            behind,
        });
    }
    Ok(refs)
}

/// An author or committer attribution line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAttribution {
    pub name: String,
    pub email: String,
    /// ISO-8601.
    pub date: String,
}

/// The full, rendered detail for one commit: message, both attributions, the
/// parents, and the changed-file list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub author: CommitAttribution,
    pub committer: CommitAttribution,
    pub parents: Vec<String>,
    pub files: Vec<GitCommitFile>,
}

/// A commit's detail. The message comes from the `git log` pretty format
/// (`%b` holds the body with the subject removed, so a multiline body needs
/// no separator juggling), and the changed-file list from `git diff-tree`,
/// which reports one commit's diff directly. A bad sha or a non-repo is an
/// error, never an empty detail.
pub fn git_commit_detail(path: String, sha: String) -> Result<CommitDetail> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    let fmt = format!("{RECORD}%H{SEP}%s{SEP}%an{SEP}%ae{SEP}%aI{SEP}%cn{SEP}%ce{SEP}%cI{SEP}%P{SEP}%b");
    let out = run_git(&path, &["log", "-1", &format!("--pretty=format:{fmt}"), &sha])?;
    if out.is_empty() {
        return Err(Error::new(format!("Unknown commit {sha}.")));
    }

    // The body (%b) is last and may itself contain the separator's friends, so
    // split at most the nine fixed fields and take the remainder as the body.
    let text = out.trim_start_matches(RECORD);
    let mut parts = text.splitn(10, SEP);
    let mut field = || parts.next().unwrap_or("").to_string();
    let detail_sha = field();
    let subject = field();
    let author = CommitAttribution {
        name: field(),
        email: field(),
        date: field(),
    };
    let committer = CommitAttribution {
        name: field(),
        email: field(),
        date: field(),
    };
    let parents = field()
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let body = parts.collect::<Vec<_>>().join(&SEP.to_string()).trim().to_string();

    let files = commit_files(&path, &sha)?;

    Ok(CommitDetail {
        sha: detail_sha,
        subject,
        body,
        author,
        committer,
        parents,
        files,
    })
}

/// A commit's changed-file list. First-parent for merges, like `git_log` —
/// a forge calls the changes a merge *brought in* the merge's files. Retried
/// without `--diff-merges` for gits too old to know it (< 2.31), where merges
/// list nothing — the old behaviour, not an error.
fn commit_files(path: &str, sha: &str) -> Result<Vec<GitCommitFile>> {
    let args = [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-M",
        "-z",
        "--diff-merges=first-parent",
        sha,
    ];
    let mut out = git(path, &args)?;
    if !out.status.success() {
        out = git(
            path,
            &["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "-z", sha],
        )?;
    }
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(super::log::parse_name_status(&String::from_utf8_lossy(&out.stdout)))
}

/// The whole multi-file unified patch one commit introduced, first-parent for
/// merges — shaped like `git_working_diff`, so @pierre/diffs renders it
/// unchanged. A bad sha or a non-repo is an error, never an empty patch.
pub fn git_commit_patch(path: String, sha: String) -> Result<String> {
    if !is_repo(&path) {
        return Err(Error::new("Not a git repository."));
    }
    let args = [
        "show",
        "--no-color",
        "--format=",
        "--diff-merges=first-parent",
        &sha,
    ];
    let mut out = git(&path, &args)?;
    if !out.status.success() {
        out = git(&path, &["show", "--no-color", "--format=", &sha])?;
    }
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::Repo;

    #[test]
    fn pages_history_across_all_refs_in_date_order() {
        let repo = Repo::new("graph_page");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.run(&["checkout", "-b", "side"]);
        repo.write("side.txt", "branch work\n");
        repo.commit("side work");
        repo.run(&["checkout", "-"]);
        repo.write("main.txt", "main work\n");
        repo.commit("main work");
        repo.run(&["merge", "--no-ff", "-m", "merge side", "side"]);
        // A commit made on a detached HEAD: reachable only from HEAD, which
        // `--all` includes, so the graph must still list it.
        repo.write("detached.txt", "dangling\n");
        repo.commit("detached work");
        let detached = repo.run(&["rev-parse", "HEAD"]);

        let page = git_graph_page(repo.path(), 10, 0).unwrap();
        let subjects: Vec<&str> = page.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects[0], "detached work");
        assert!(subjects.contains(&"merge side"));
        assert!(subjects.contains(&"side work"));
        assert!(subjects.contains(&"main work"));
        // --all includes the commit only a detached HEAD reaches.
        assert!(page.iter().any(|c| c.sha == detached));

        // Pagination: skip the first 3, get the rest, in the same order.
        let page2 = git_graph_page(repo.path(), 10, 3).unwrap();
        assert_eq!(page2.len(), page.len().saturating_sub(3));
        assert_eq!(page2[0].sha, page[3].sha);

        // The merge carries two parents and every row has the render fields.
        let merge = page.iter().find(|c| c.subject == "merge side").unwrap();
        assert!(merge.parents.len() > 1);
        for c in &page {
            assert!(c.sha.starts_with(&c.short_sha));
            assert!(c.author_date.starts_with("20"));
            assert!(!c.relative_date.is_empty());
        }
    }

    #[test]
    fn rejects_empty_limit_and_non_repo() {
        let repo = Repo::new("graph_empty");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        assert!(git_graph_page(repo.path(), 0, 0).unwrap().is_empty());
        assert!(git_graph_page("/nonexistent".into(), 10, 0).is_err());
    }

    #[test]
    fn lists_branches_tags_and_remotes_with_peeled_targets() {
        let origin = Repo::new("graph_origin");
        origin.write("a.txt", "one\n");
        origin.commit("init");

        let repo = Repo::new("graph_refs");
        repo.run(&["remote", "add", "origin", &origin.path()]);
        repo.run(&["fetch", "origin"]);
        repo.run(&["checkout", "-B", "main", "--track", "origin/main"]);
        repo.write("b.txt", "local\n");
        repo.commit("local work");
        repo.run(&["tag", "-a", "-m", "v1 release", "v1"]);

        let refs = git_graph_refs(repo.path()).unwrap();
        let branch = refs.iter().find(|r| r.short_name == "main" && r.kind == "branch").unwrap();
        assert!(branch.is_head);
        assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
        // The clone is ahead of its upstream by the local work it added.
        assert_eq!(branch.ahead, 1);

        let tag = refs.iter().find(|r| r.kind == "tag").unwrap();
        assert_eq!(tag.short_name, "v1");
        // Annotated tag peeled to the commit it points at.
        assert_eq!(tag.target_sha, branch.target_sha);

        let remote = refs.iter().find(|r| r.short_name == "origin/main").unwrap();
        assert_eq!(remote.kind, "remote");
        assert!(!remote.is_head);
        // A remote ref tracks nothing itself, so it has no ahead/behind.
        assert_eq!((remote.ahead, remote.behind), (0, 0));
    }

    #[test]
    fn reads_a_commit_detail_with_body_parents_and_files() {
        let repo = Repo::new("graph_detail");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.run(&["checkout", "-b", "side"]);
        repo.write("side.txt", "from the branch\n");
        repo.run(&["add", "-A"]);
        repo.run(&["commit", "-m", "side work\n\nA longer body over two lines."]);
        let side_sha = repo.run(&["rev-parse", "HEAD"]);
        repo.run(&["checkout", "-"]);
        repo.write("main.txt", "on main\n");
        repo.commit("main work");
        repo.run(&["merge", "--no-ff", "-m", "merge side", "side"]);

        let detail = git_commit_detail(repo.path(), side_sha.clone()).unwrap();
        assert_eq!(detail.sha, side_sha);
        assert_eq!(detail.subject, "side work");
        assert!(detail.body.contains("A longer body over two lines."));
        assert_eq!(detail.author.name, "Emberyx Test");
        assert!(detail.author.date.starts_with("20"));
        assert!(detail.files.iter().any(|f| f.path == "side.txt"));

        // A merge's files are the changes it brought in (first parent).
        let merge_sha = repo.run(&["rev-parse", "HEAD"]);
        let merge = git_commit_detail(repo.path(), merge_sha).unwrap();
        assert!(merge.parents.len() > 1);
        assert!(merge.files.iter().any(|f| f.path == "side.txt"));

        // A bad sha is an error, never an empty detail.
        assert!(git_commit_detail(repo.path(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into()).is_err());
    }

    #[test]
    fn renders_a_commit_patch_like_the_working_tree() {
        let repo = Repo::new("graph_patch");
        repo.write("a.txt", "one\n");
        repo.commit("first");
        repo.run(&["checkout", "-b", "side"]);
        repo.write("side.txt", "from the branch\n");
        repo.commit("side work");
        repo.run(&["checkout", "-"]);
        repo.write("main.txt", "on main\n");
        repo.commit("main work");
        repo.run(&["merge", "--no-ff", "-m", "merge side", "side"]);
        let merge_sha = repo.run(&["rev-parse", "HEAD"]);

        let patch = git_commit_patch(repo.path(), merge_sha).unwrap();
        assert!(patch.contains("diff --git"));
        assert!(patch.contains("side.txt"));
        assert!(patch.contains("from the branch"));
        assert!(git_commit_patch(repo.path(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into()).is_err());
    }

    #[test]
    fn parses_upstream_track_strings() {
        assert_eq!(parse_track("[ahead 1]"), (1, 0));
        assert_eq!(parse_track("[behind 2]"), (0, 2));
        assert_eq!(parse_track("[ahead 1, behind 2]"), (1, 2));
        assert_eq!(parse_track("[gone]"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }
}