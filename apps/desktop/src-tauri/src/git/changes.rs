use std::path::Path;

use super::{failure, git, git_stdin, is_repo, run_git, unquote_path, GitFile};
use crate::error::{Error, Result};

/// List working-tree changes (staged, unstaged, untracked).
pub fn git_changes(path: String) -> Result<Vec<GitFile>> {
    // Outside a repo `status` fails, and that is the "no changes" answer — no
    // separate repo check (a second process) needed.
    let out = git(&path, &["status", "--porcelain=v1"])?;
    if !out.status.success() {
        return Ok(vec![]);
    }
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
pub fn git_file_diff(
    path: String,
    file: String,
    untracked: bool,
    staged: bool,
    ignore_whitespace: Option<bool>,
) -> Result<String> {
    if untracked {
        let content = std::fs::read_to_string(Path::new(&path).join(&file)).unwrap_or_default();
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

/// One multi-file unified patch for the whole working tree: the index diff
/// (`--cached`) when `staged`, else what the working tree has on top of the
/// index. Untracked files are diffed against `/dev/null` with `--no-index` so
/// they arrive as real `diff --git` blocks — `git_file_diff` returns them as
/// bare `+` lines, which is fine for one file but unparseable as a patch.
///
/// `ignore_whitespace` passes `-w`. Note that a `-w` patch has line counts that
/// no longer match the file, so it renders but cannot be fed back to
/// `git apply`; staging a hunk re-reads the file's patch without it.
pub fn git_working_diff(
    path: String,
    staged: bool,
    ignore_whitespace: Option<bool>,
) -> Result<String> {
    let mut args = vec!["diff", "--no-color"];
    if ignore_whitespace.unwrap_or(false) {
        args.push("-w");
    }
    if staged {
        args.push("--cached");
    }
    let out = git(&path, &args)?;
    if !out.status.success() {
        return if is_repo(&path) {
            Err(failure(&out))
        } else {
            Ok(String::new())
        };
    }
    let mut patch = String::from_utf8_lossy(&out.stdout).to_string();

    // The index already holds a staged file's content, so untracked files only
    // belong in the working-tree half.
    if !staged {
        for file in git_changes(path.clone())?.iter().filter(|f| f.untracked) {
            patch.push_str(&untracked_patch(&path, &file.path));
        }
    }
    Ok(patch)
}

/// A `diff --git` block for a file git isn't tracking yet. `--no-index` against
/// `/dev/null` is git's own way to spell "everything in here is an addition",
/// so the result parses like any other file in the patch. `--no-index` exits 1
/// when the files differ, which is the expected case, so the status is ignored
/// and only genuinely empty output is treated as nothing to add.
fn untracked_patch(path: &str, file: &str) -> String {
    let out = git(
        path,
        &["diff", "--no-color", "--no-index", "--", "/dev/null", file],
    );
    match out {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => String::new(),
    }
}

/// Add paths to the index (picks up untracked files too).
pub fn git_stage(path: String, files: Vec<String>) -> Result<String> {
    if files.is_empty() {
        return Err(Error::new("No files selected."));
    }
    let mut args = vec!["add", "--"];
    args.extend(files.iter().map(|f| f.as_str()));
    run_git(&path, &args)
}

/// Drop paths from the index, leaving the working tree untouched.
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

/// One file's slice of a multi-file patch, cut out of the text git produced —
/// never re-rendered from a parsed model. Re-rendering is the difference
/// between a patch that applies and one that only usually does.
fn split_file_patches(patch: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            if let Some(lines) = current.take() {
                sections.push((path_of(&lines), lines.join("\n")));
            }
            current = Some(vec![line]);
        } else if let Some(lines) = current.as_mut() {
            lines.push(line);
        }
    }
    if let Some(lines) = current.take() {
        sections.push((path_of(&lines), lines.join("\n")));
    }
    sections
}

/// The path a patch section names. The `---` line comes first in a section, so
/// a diff whose pre- and post-image names differ reads as the pre-image — the
/// behavior the panel's anchors were built against, kept byte-exact.
fn path_of(lines: &[&str]) -> String {
    for line in lines {
        if let Some(rest) = line.strip_prefix("+++ ") {
            let name = rest.trim();
            if name != "/dev/null" {
                return name.strip_prefix("b/").unwrap_or(name).to_string();
            }
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            let name = rest.trim();
            if name != "/dev/null" {
                return name.strip_prefix("a/").unwrap_or(name).to_string();
            }
        }
    }
    // No `---`/`+++` lines: the `diff --git` line carries both names.
    for line in lines {
        if let Some(rest) = line.strip_prefix("diff --git a/") {
            if let Some(pos) = rest.find(" b/") {
                let (a, b) = (&rest[..pos], &rest[pos + 3..]);
                return if b.is_empty() {
                    a.to_string()
                } else {
                    b.to_string()
                };
            }
            return rest.to_string();
        }
    }
    String::new()
}

/// A standalone one-hunk patch for `git apply`, cut from `patch` — the file's
/// own section with the requested hunk, headers included. `None` when the file
/// or hunk isn't in the patch: a stale index after the tree moved under the
/// render, which must not silently apply the wrong hunk.
fn hunk_patch_for_file(patch: &str, file: &str, hunk_index: usize) -> Option<String> {
    let (_, section) = split_file_patches(patch)
        .into_iter()
        .find(|(p, _)| p == file)?;

    // The two `---`/`+++` lines are the whole header git apply needs; the
    // `diff --git` line is dropped, matching what the panel fed it one file at
    // a time before this moved here.
    let mut file_header: Vec<&str> = Vec::new();
    let mut hunks: Vec<(String, Vec<&str>)> = Vec::new();
    for line in section.split('\n') {
        if line.starts_with("@@") {
            hunks.push((line.to_string(), Vec::new()));
            continue;
        }
        match hunks.last_mut() {
            Some((_, body)) => body.push(line),
            None => {
                if line.starts_with("--- ") || line.starts_with("+++ ") {
                    file_header.push(line);
                }
            }
        }
    }
    let (hunk_header, body) = hunks.into_iter().nth(hunk_index)?;
    // Trailing blank lines come from the split's final newline; git rejects a
    // patch with stray empty lines inside the hunk body.
    let mut body = body;
    while body.last().is_some_and(|l| l.is_empty()) {
        body.pop();
    }
    let hunk_text = if body.is_empty() {
        hunk_header.clone()
    } else {
        let mut text = hunk_header.clone();
        for line in body {
            text.push('\n');
            text.push_str(line);
        }
        text
    };
    let header = if file_header.is_empty() {
        format!("--- a/{file}\n+++ b/{file}")
    } else {
        file_header.join("\n")
    };
    Some(format!("{header}\n{hunk_text}\n"))
}

/// Apply — stage, unstage or discard — one hunk of one file, cut out of the
/// whole-scope patch the panel renders. The frontend hands over the patch its
/// rendered hunks came from (the deferred one, not the newest): the index the
/// user clicked only means anything in that text.
pub fn git_apply_hunk(
    path: String,
    patch: String,
    file: String,
    hunk_index: usize,
    cached: bool,
    reverse: bool,
) -> Result<String> {
    let slice = hunk_patch_for_file(&patch, &file, hunk_index).ok_or_else(|| {
        Error::new("That hunk is no longer in the patch — refresh and try again.")
    })?;
    git_apply(path, slice, cached, reverse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{status_of, Repo};
    use crate::git::{git_branch_delete, git_checkout, git_commit};

    #[test]
    fn working_diff_carries_every_changed_file_in_one_patch() {
        let repo = Repo::new("working_diff");
        std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "one\n").unwrap();
        repo.run(&["add", "."]);
        repo.run(&["commit", "-m", "first"]);
        std::fs::write(repo.0.join("a.txt"), "two\n").unwrap();
        std::fs::write(repo.0.join("b.txt"), "two\n").unwrap();

        let patch = git_working_diff(repo.0.to_str().unwrap().into(), false, None).unwrap();
        // One patch, both files, each with its own `diff --git` header — which is
        // what makes it parseable as a multi-file patch.
        assert_eq!(patch.matches("diff --git").count(), 2);
        assert!(patch.contains("a/a.txt"));
        assert!(patch.contains("a/b.txt"));
        assert!(patch.contains("+two"));
    }

    #[test]
    fn working_diff_gives_untracked_files_a_real_diff_header() {
        let repo = Repo::new("working_diff_untracked");
        std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
        repo.run(&["add", "."]);
        repo.run(&["commit", "-m", "first"]);
        std::fs::write(repo.0.join("new.txt"), "fresh\n").unwrap();

        let patch = git_working_diff(repo.0.to_str().unwrap().into(), false, None).unwrap();
        // Not bare `+` lines the way git_file_diff returns them: the renderer
        // needs a header to know which file the additions belong to.
        assert!(patch.contains("diff --git"));
        assert!(patch.contains("new.txt"));
        assert!(patch.contains("+fresh"));
    }

    #[test]
    fn working_diff_staged_reads_the_index_and_skips_untracked() {
        let repo = Repo::new("working_diff_staged");
        std::fs::write(repo.0.join("a.txt"), "one\n").unwrap();
        repo.run(&["add", "."]);
        repo.run(&["commit", "-m", "first"]);
        std::fs::write(repo.0.join("a.txt"), "two\n").unwrap();
        repo.run(&["add", "a.txt"]);
        std::fs::write(repo.0.join("new.txt"), "fresh\n").unwrap();

        let patch = git_working_diff(repo.0.to_str().unwrap().into(), true, None).unwrap();
        assert!(patch.contains("+two"));
        // An untracked file has nothing in the index, so it belongs to the
        // working-tree half only — listing it here would offer to unstage
        // something that was never staged.
        assert!(!patch.contains("new.txt"));
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
        assert!(
            files
                .iter()
                .find(|f| f.path == "fresh.txt")
                .unwrap()
                .untracked
        );
        assert!(
            !files
                .iter()
                .find(|f| f.path == "tracked.txt")
                .unwrap()
                .untracked
        );
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
            err.to_string().contains("patch does not apply") || err.to_string().contains("error"),
            "unexpected error: {err}"
        );
    }

    /// The same shape the changes panel feeds `git_apply_hunk`: git's own
    /// multi-file output for two files, two hunks in the first.
    const TWO_FILES: &str = "diff --git a/a.txt b/a.txt\n\
index 111..222 100644\n\
--- a/a.txt\n\
+++ b/a.txt\n\
@@ -1,3 +1,3 @@\n\
 one\n\
-two\n\
+TWO\n\
 three\n\
@@ -10,3 +10,3 @@\n\
 ten\n\
-eleven\n\
+ELEVEN\n\
 twelve\n\
diff --git a/dir/b.ts b/dir/b.ts\n\
index 333..444 100644\n\
--- a/dir/b.ts\n\
+++ b/dir/b.ts\n\
@@ -1,2 +1,2 @@\n\
-const a = 1\n\
+const a = 2\n\
 export {}\n";

    #[test]
    fn splits_a_patch_by_file_and_names_the_post_image_path() {
        let files = split_file_patches(TWO_FILES);
        assert_eq!(
            files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
            ["a.txt", "dir/b.ts"]
        );
        assert!(files[0].1.starts_with("diff --git a/a.txt"));

        // A deletion names its pre-image: the post-image is /dev/null.
        let deletion = "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
        assert_eq!(split_file_patches(deletion)[0].0, "gone.txt");

        // Anything before the first file header is not a file.
        assert!(split_file_patches("warning: noise\n").is_empty());
    }

    #[test]
    fn cuts_one_hunk_with_its_file_headers_and_nothing_else() {
        let first = hunk_patch_for_file(TWO_FILES, "a.txt", 0).unwrap();
        assert!(first.contains("--- a/a.txt"));
        assert!(first.contains("+++ b/a.txt"));
        assert!(first.contains("+TWO"));
        assert!(!first.contains("+ELEVEN"));

        let second = hunk_patch_for_file(TWO_FILES, "a.txt", 1).unwrap();
        assert!(second.contains("+ELEVEN"));
        assert!(!second.contains("+TWO"));

        // The section boundary holds: one file's hunk never names another.
        let last = hunk_patch_for_file(TWO_FILES, "dir/b.ts", 0).unwrap();
        assert!(last.contains("const a = 2"));
        assert!(!last.contains("a.txt"));
        assert!(last.ends_with('\n'));
    }

    #[test]
    fn a_stale_hunk_index_returns_none_not_the_wrong_hunk() {
        assert!(hunk_patch_for_file(TWO_FILES, "a.txt", 5).is_none());
        assert!(hunk_patch_for_file(TWO_FILES, "nope.txt", 0).is_none());
    }

    #[test]
    fn applies_exactly_one_hunk_to_the_index() {
        let repo = Repo::new("hunk_stage");
        repo.write(
            "a.txt",
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
        );
        repo.commit("init");
        repo.write(
            "a.txt",
            "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\nELEVEN\ntwelve\n",
        );
        let patch = repo.run(&["diff", "--", "a.txt"]);

        git_apply_hunk(repo.path(), patch, "a.txt".into(), 0, true, false).unwrap();

        // The index carries the first hunk only; the second stays unstaged.
        let staged = repo.run(&["diff", "--cached", "--", "a.txt"]);
        assert!(staged.contains("+TWO"), "{staged}");
        assert!(!staged.contains("+ELEVEN"), "{staged}");
        let unstaged = repo.run(&["diff", "--", "a.txt"]);
        assert!(unstaged.contains("+ELEVEN"), "{unstaged}");
        assert!(!unstaged.contains("+TWO"), "{unstaged}");
    }

    #[test]
    fn discards_a_hunk_from_the_working_tree() {
        let repo = Repo::new("hunk_discard");
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.commit("init");
        repo.write("a.txt", "one\nTWO\nthree\n");
        let patch = repo.run(&["diff", "--", "a.txt"]);

        git_apply_hunk(repo.path(), patch, "a.txt".into(), 0, false, true).unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap(),
            "one\ntwo\nthree\n"
        );
    }

    #[test]
    fn a_hunk_no_longer_in_the_patch_is_refused_not_applied_blindly() {
        let repo = Repo::new("hunk_stale");
        repo.write("a.txt", "one\ntwo\nthree\n");
        repo.commit("init");

        let error = git_apply_hunk(
            repo.path(),
            TWO_FILES.into(),
            "a.txt".into(),
            5,
            true,
            false,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("no longer in the patch"),
            "{error}"
        );
    }
}
