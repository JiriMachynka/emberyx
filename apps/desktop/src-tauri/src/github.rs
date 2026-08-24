//! GitHub pull requests, to the same contract GitLab merge requests already
//! speak (`gitlab.rs`).
//!
//! The frontend review panel is deliberately provider-neutral, so this module's
//! job is translation, not a second vocabulary: GitHub's `number` becomes `iid`,
//! `head.ref`/`base.ref` become source/target branch, and the state is
//! normalised to GitLab's `opened | merged | closed` — GitHub reports a merged
//! PR as `closed` with a `merged_at`, which would otherwise read as "rejected".
//!
//! The token lives in the OS keychain and never crosses the Tauri boundary; each
//! request re-reads it here.

use std::process::Command;
use std::time::Duration;

use serde::Deserialize;

use crate::error::Result;
use crate::gitlab::{MergeRequest, MergeRequestDetail, MrDiffFile, MrNote};

const API_BASE: &str = "https://api.github.com";
const KEYCHAIN_SERVICE: &str = "emberyx";
const KEYCHAIN_ACCOUNT: &str = "github.com";
const NO_TOKEN: &str = "No GitHub token — add one in Settings";
const NOT_GITHUB: &str = "Not a github.com repository";
/// GitHub rejects requests without one, and pins the response shape by version.
const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "emberyx";

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| crate::err!("Keychain unavailable: {e}"))
}

fn token() -> Result<String> {
    let value = entry()?
        .get_password()
        .map_err(|_| crate::err!("{NO_TOKEN}"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(NO_TOKEN.into());
    }
    Ok(value)
}

#[tauri::command]
pub fn github_set_token(token: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token is empty".into());
    }
    entry()?
        .set_password(token)
        .map_err(|e| crate::err!("Could not save token to the keychain: {e}"))
}

#[tauri::command]
pub fn github_has_token() -> Result<bool> {
    Ok(entry()?
        .get_password()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false))
}

#[tauri::command]
pub fn github_clear_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Clearing a token that was never stored is a no-op, not a failure.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(crate::err!("Could not clear token from the keychain: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Repo → owner/repo
// ---------------------------------------------------------------------------

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

/// `owner/repo` for a github.com remote, or `None` when it points elsewhere.
/// GitHub repos are always exactly two segments — unlike GitLab, a longer path
/// is not a nested group but a URL that is not a repository.
pub(crate) fn github_slug(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    let (authority, path) = if let Some(idx) = s.find("://") {
        s[idx + 3..].split_once('/')?
    } else {
        // scp-form `git@github.com:owner/repo`.
        s.split_once(':')?
    };
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let segs: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|x| !x.is_empty())
        .collect();
    (segs.len() == 2).then(|| segs.join("/"))
}

fn repo(path: &str) -> Result<String> {
    remote_url(path)
        .as_deref()
        .and_then(github_slug)
        .ok_or_else(|| NOT_GITHUB.into())
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn get_json<T: serde::de::DeserializeOwned>(url: &str, token: &str) -> Result<T> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20))
        .build();
    let resp = agent
        .get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", API_VERSION)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => match code {
                401 => crate::err!("GitHub rejected the token — check it in Settings"),
                403 => crate::err!(
                    "GitHub refused the request — the token may lack `repo` scope, or you are rate limited"
                ),
                404 => crate::err!("Repository not found on GitHub — check the token's access"),
                _ => {
                    let body = resp.into_string().unwrap_or_default();
                    crate::err!("GitHub error {code}: {}", body.trim())
                }
            },
            other => crate::err!("GitHub request failed: {other}"),
        })?;
    resp.into_json()
        .map_err(|e| crate::err!("Unexpected GitHub response: {e}"))
}

// ---------------------------------------------------------------------------
// Wire types (GitHub). Deserialized separately so added or omitted GitHub
// fields can never break the frontend contract.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ApiUser {
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Deserialize, Default)]
struct ApiRef {
    #[serde(rename = "ref", default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct ApiPr {
    number: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    head: Option<ApiRef>,
    #[serde(default)]
    base: Option<ApiRef>,
    #[serde(default)]
    user: Option<ApiUser>,
    #[serde(default)]
    draft: Option<bool>,
    /// Null until GitHub has computed mergeability — unknown is not a conflict.
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    changed_files: Option<u64>,
}

/// GitHub reports a merged PR as `closed` with a `merged_at`. Collapsing the
/// two would show every merged PR as rejected.
pub(crate) fn normalize_state(state: Option<&str>, merged_at: Option<&str>) -> String {
    if merged_at.is_some() {
        return "merged".into();
    }
    match state {
        Some("open") => "opened".into(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

impl ApiPr {
    fn author_parts(&self) -> (String, Option<String>) {
        match &self.user {
            Some(u) => (
                u.login.clone().unwrap_or_default(),
                u.avatar_url.clone().filter(|url| !url.is_empty()),
            ),
            None => (String::new(), None),
        }
    }

    fn branches(&self) -> (String, String) {
        (
            self.head
                .as_ref()
                .and_then(|r| r.name.clone())
                .unwrap_or_default(),
            self.base
                .as_ref()
                .and_then(|r| r.name.clone())
                .unwrap_or_default(),
        )
    }

    fn into_summary(self) -> MergeRequest {
        let (author_name, author_avatar_url) = self.author_parts();
        let (source_branch, target_branch) = self.branches();
        MergeRequest {
            iid: self.number,
            title: self.title.unwrap_or_default(),
            state: normalize_state(self.state.as_deref(), self.merged_at.as_deref()),
            web_url: self.html_url.unwrap_or_default(),
            source_branch,
            target_branch,
            author_name,
            author_avatar_url,
            draft: self.draft.unwrap_or(false),
            has_conflicts: self.mergeable == Some(false),
            updated_at: self.updated_at.unwrap_or_default(),
        }
    }

    fn into_detail(self) -> MergeRequestDetail {
        let (author_name, author_avatar_url) = self.author_parts();
        let (source_branch, target_branch) = self.branches();
        MergeRequestDetail {
            iid: self.number,
            title: self.title.unwrap_or_default(),
            state: normalize_state(self.state.as_deref(), self.merged_at.as_deref()),
            web_url: self.html_url.unwrap_or_default(),
            source_branch,
            target_branch,
            author_name,
            author_avatar_url,
            draft: self.draft.unwrap_or(false),
            has_conflicts: self.mergeable == Some(false),
            updated_at: self.updated_at.unwrap_or_default(),
            description: self.body.filter(|b| !b.is_empty()),
            changes_count: self.changed_files.map(|n| n.to_string()),
        }
    }
}

#[derive(Deserialize)]
struct ApiFile {
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    previous_filename: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// Absent for binary files and for diffs GitHub declines to render.
    #[serde(default)]
    patch: Option<String>,
}

#[derive(Deserialize)]
struct ApiComment {
    id: u64,
    #[serde(default)]
    user: Option<ApiUser>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    /// Set on review comments — the file the remark is anchored to.
    #[serde(default)]
    path: Option<String>,
}

impl ApiComment {
    fn into_note(self) -> MrNote {
        let path = self.path.clone();
        MrNote {
            id: self.id,
            author_name: self.user.and_then(|u| u.login).unwrap_or_default(),
            // An inline review remark reads as floating prose without the file
            // it is about.
            body: match (path, self.body.unwrap_or_default()) {
                (Some(path), body) if !path.is_empty() => format!("`{path}`\n\n{body}"),
                (_, body) => body,
            },
            created_at: self.created_at.unwrap_or_default(),
            system: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// GitHub's `state` only accepts open/closed/all, so "merged" is fetched as
/// `all` and filtered here.
fn query_state(state: &str) -> Result<&'static str> {
    match state {
        "opened" => Ok("open"),
        "closed" => Ok("closed"),
        "merged" | "all" => Ok("all"),
        other => Err(crate::err!("Unknown pull request state: {other}")),
    }
}

#[tauri::command]
pub async fn github_prs(path: String, state: String) -> Result<Vec<MergeRequest>> {
    tauri::async_runtime::spawn_blocking(move || {
        let query = query_state(&state)?;
        let token = token()?;
        let repo = repo(&path)?;
        let url = format!(
            "{API_BASE}/repos/{repo}/pulls?state={query}&per_page=50&sort=updated&direction=desc"
        );
        let prs: Vec<ApiPr> = get_json(&url, &token)?;
        let mut out: Vec<MergeRequest> = prs.into_iter().map(ApiPr::into_summary).collect();
        if state == "merged" {
            out.retain(|pr| pr.state == "merged");
        } else if state == "closed" {
            // "closed" asked for rejected ones; merged has its own filter.
            out.retain(|pr| pr.state == "closed");
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_pr(path: String, iid: u64) -> Result<MergeRequestDetail> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token()?;
        let repo = repo(&path)?;
        let url = format!("{API_BASE}/repos/{repo}/pulls/{iid}");
        let pr: ApiPr = get_json(&url, &token)?;
        Ok(pr.into_detail())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn github_pr_diff(path: String, iid: u64) -> Result<Vec<MrDiffFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token()?;
        let repo = repo(&path)?;
        let url = format!("{API_BASE}/repos/{repo}/pulls/{iid}/files?per_page=100");
        let files: Vec<ApiFile> = get_json(&url, &token)?;
        Ok(files
            .into_iter()
            .map(|f| {
                let new_path = f.filename.unwrap_or_default();
                let status = f.status.unwrap_or_default();
                MrDiffFile {
                    old_path: f.previous_filename.unwrap_or_else(|| new_path.clone()),
                    new_path,
                    // Binary files come back with no patch; an empty diff is the
                    // honest rendering, not a missing file.
                    diff: f.patch.unwrap_or_default(),
                    new_file: status == "added",
                    renamed_file: status == "renamed",
                    deleted_file: status == "removed",
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The conversation on a PR: the issue thread and the inline review remarks,
/// merged into one timeline. GitHub keeps them on separate endpoints; a review
/// that only exists inline would otherwise look like an empty discussion.
#[tauri::command]
pub async fn github_pr_notes(path: String, iid: u64) -> Result<Vec<MrNote>> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token()?;
        let repo = repo(&path)?;
        let issue_url = format!("{API_BASE}/repos/{repo}/issues/{iid}/comments?per_page=100");
        let review_url = format!("{API_BASE}/repos/{repo}/pulls/{iid}/comments?per_page=100");
        let issue: Vec<ApiComment> = get_json(&issue_url, &token)?;
        let review: Vec<ApiComment> = get_json(&review_url, &token)?;
        let mut notes: Vec<MrNote> = issue
            .into_iter()
            .chain(review)
            .map(ApiComment::into_note)
            .collect();
        // ISO-8601 in UTC sorts lexicographically, which is what GitHub returns.
        notes.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(notes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_repo_from_every_remote_form() {
        for raw in [
            "https://github.com/owner/repo.git",
            "https://github.com/owner/repo",
            "git@github.com:owner/repo.git",
            "ssh://git@github.com:22/owner/repo.git",
            "https://user:token@github.com/owner/repo.git",
        ] {
            assert_eq!(github_slug(raw).as_deref(), Some("owner/repo"), "{raw}");
        }
    }

    #[test]
    fn ignores_remotes_that_are_not_github() {
        assert_eq!(github_slug("git@gitlab.com:group/repo.git"), None);
        assert_eq!(github_slug("https://example.com/owner/repo.git"), None);
        // A GitHub URL that isn't a repository (a gist, a user page).
        assert_eq!(github_slug("https://github.com/owner"), None);
        assert_eq!(github_slug("https://github.com/owner/repo/tree/main"), None);
    }

    // GitHub reports a merged PR as closed; showing that as "closed" would read
    // as rejected.
    #[test]
    fn a_merged_pull_request_is_not_reported_as_closed() {
        assert_eq!(
            normalize_state(Some("closed"), Some("2026-01-01T00:00:00Z")),
            "merged"
        );
        assert_eq!(normalize_state(Some("closed"), None), "closed");
        assert_eq!(normalize_state(Some("open"), None), "opened");
        assert_eq!(normalize_state(None, None), "");
    }

    #[test]
    fn state_filters_map_onto_githubs_own_vocabulary() {
        assert_eq!(query_state("opened").unwrap(), "open");
        assert_eq!(query_state("closed").unwrap(), "closed");
        // GitHub has no "merged" filter — fetch everything and narrow locally.
        assert_eq!(query_state("merged").unwrap(), "all");
        assert_eq!(query_state("all").unwrap(), "all");
        assert!(query_state("nonsense").is_err());
    }
}
