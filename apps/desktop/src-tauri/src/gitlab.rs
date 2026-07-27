use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Result;

const API_BASE: &str = "https://gitlab.com/api/v4";
const KEYCHAIN_SERVICE: &str = "emberyx";
const KEYCHAIN_ACCOUNT: &str = "gitlab.com";
const NO_TOKEN: &str = "No GitLab token — add one in Settings";
const NOT_GITLAB: &str = "Not a gitlab.com repository";

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| crate::err!("Keychain unavailable: {e}"))
}

/// Read the PAT from the OS keychain. Never crosses the Tauri boundary — every
/// request re-reads it here so the frontend never holds the secret.
fn token() -> Result<String> {
    let value = entry()?.get_password().map_err(|_| crate::err!("{NO_TOKEN}"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(NO_TOKEN.into());
    }
    Ok(value)
}

#[tauri::command]
pub fn gitlab_set_token(token: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Token is empty".into());
    }
    entry()?
        .set_password(token)
        .map_err(|e| crate::err!("Could not save token to the keychain: {e}"))
}

#[tauri::command]
pub fn gitlab_has_token() -> Result<bool> {
    Ok(entry()?
        .get_password()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false))
}

#[tauri::command]
pub fn gitlab_clear_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Clearing a token that was never stored is a no-op, not a failure.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(crate::err!("Could not clear token from the keychain: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Repo → project path
// ---------------------------------------------------------------------------

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

/// Full gitlab.com project path (`group/sub/repo`) for a git remote URL, or
/// `None` when the remote points elsewhere. Unlike the two-segment slug used
/// for Dokploy matching, nested groups must survive — GitLab addresses projects
/// by their whole namespace path.
fn gitlab_slug(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    let (authority, path) = if let Some(idx) = s.find("://") {
        s[idx + 3..].split_once('/')?
    } else {
        // scp-form `git@host:group/repo`.
        s.split_once(':')?
    };
    // Strip credentials and any port from the authority to get the bare host.
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    if !host.eq_ignore_ascii_case("gitlab.com") {
        return None;
    }
    let segs: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|x| !x.is_empty())
        .collect();
    (segs.len() >= 2).then(|| segs.join("/"))
}

/// Percent-encode a project path so `group/sub/repo` survives as one path
/// segment in `/projects/{id}`.
fn encode_path(slug: &str) -> String {
    slug.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn project(path: &str) -> Result<String> {
    remote_url(path)
        .as_deref()
        .and_then(gitlab_slug)
        .map(|slug| encode_path(&slug))
        .ok_or_else(|| NOT_GITLAB.into())
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
        .set("PRIVATE-TOKEN", token)
        .set("accept", "application/json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => match code {
                401 | 403 => crate::err!("GitLab rejected the token — check it in Settings"),
                404 => crate::err!("Project not found on GitLab — check the token's access"),
                _ => {
                    let body = resp.into_string().unwrap_or_default();
                    crate::err!("GitLab error {code}: {}", body.trim())
                }
            },
            other => crate::err!("GitLab request failed: {other}"),
        })?;
    resp.into_json()
        .map_err(|e| crate::err!("Unexpected GitLab response: {e}"))
}

// ---------------------------------------------------------------------------
// Wire types (frontend)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub iid: u64,
    pub title: String,
    pub state: String,
    pub web_url: String,
    pub source_branch: String,
    pub target_branch: String,
    pub author_name: String,
    pub author_avatar_url: Option<String>,
    pub draft: bool,
    pub has_conflicts: bool,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestDetail {
    pub iid: u64,
    pub title: String,
    pub state: String,
    pub web_url: String,
    pub source_branch: String,
    pub target_branch: String,
    pub author_name: String,
    pub author_avatar_url: Option<String>,
    pub draft: bool,
    pub has_conflicts: bool,
    pub updated_at: String,
    pub description: Option<String>,
    pub changes_count: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrDiffFile {
    pub old_path: String,
    pub new_path: String,
    pub diff: String,
    pub new_file: bool,
    pub renamed_file: bool,
    pub deleted_file: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MrNote {
    pub id: u64,
    pub author_name: String,
    pub body: String,
    pub created_at: String,
    pub system: bool,
}

// ---------------------------------------------------------------------------
// Wire types (GitLab). Deserialized separately so added or omitted GitLab
// fields can never break the frontend contract.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ApiAuthor {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct ApiMr {
    iid: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    source_branch: Option<String>,
    #[serde(default)]
    target_branch: Option<String>,
    #[serde(default)]
    author: Option<ApiAuthor>,
    #[serde(default)]
    draft: Option<bool>,
    // Absent on the list endpoint for some MRs.
    #[serde(default)]
    has_conflicts: Option<bool>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    changes_count: Option<String>,
}

impl ApiMr {
    fn author_parts(&self) -> (String, Option<String>) {
        match &self.author {
            Some(a) => (
                a.name.clone().unwrap_or_default(),
                a.avatar_url.clone().filter(|u| !u.is_empty()),
            ),
            None => (String::new(), None),
        }
    }

    fn into_summary(self) -> MergeRequest {
        let (author_name, author_avatar_url) = self.author_parts();
        MergeRequest {
            iid: self.iid,
            title: self.title.unwrap_or_default(),
            state: self.state.unwrap_or_default(),
            web_url: self.web_url.unwrap_or_default(),
            source_branch: self.source_branch.unwrap_or_default(),
            target_branch: self.target_branch.unwrap_or_default(),
            author_name,
            author_avatar_url,
            draft: self.draft.unwrap_or(false),
            has_conflicts: self.has_conflicts.unwrap_or(false),
            updated_at: self.updated_at.unwrap_or_default(),
        }
    }

    fn into_detail(self) -> MergeRequestDetail {
        let (author_name, author_avatar_url) = self.author_parts();
        MergeRequestDetail {
            iid: self.iid,
            title: self.title.unwrap_or_default(),
            state: self.state.unwrap_or_default(),
            web_url: self.web_url.unwrap_or_default(),
            source_branch: self.source_branch.unwrap_or_default(),
            target_branch: self.target_branch.unwrap_or_default(),
            author_name,
            author_avatar_url,
            draft: self.draft.unwrap_or(false),
            has_conflicts: self.has_conflicts.unwrap_or(false),
            updated_at: self.updated_at.unwrap_or_default(),
            description: self.description.filter(|d| !d.is_empty()),
            changes_count: self.changes_count,
        }
    }
}

#[derive(Deserialize)]
struct ApiDiff {
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    diff: Option<String>,
    #[serde(default)]
    new_file: Option<bool>,
    #[serde(default)]
    renamed_file: Option<bool>,
    #[serde(default)]
    deleted_file: Option<bool>,
}

#[derive(Deserialize)]
struct ApiNote {
    id: u64,
    #[serde(default)]
    author: Option<ApiAuthor>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    system: Option<bool>,
}

// ---------------------------------------------------------------------------
// Commands. All network work runs on a blocking pool — a sync `#[tauri::command]`
// would block the main thread and freeze the UI.
// ---------------------------------------------------------------------------

fn valid_state(state: &str) -> Result<&'static str> {
    match state {
        "opened" => Ok("opened"),
        "merged" => Ok("merged"),
        "closed" => Ok("closed"),
        "all" => Ok("all"),
        other => Err(crate::err!("Unknown merge request state: {other}")),
    }
}

#[tauri::command]
pub async fn gitlab_mrs(path: String, state: String) -> Result<Vec<MergeRequest>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = valid_state(&state)?;
        let token = token()?;
        let project = project(&path)?;
        let url = format!(
            "{API_BASE}/projects/{project}/merge_requests?state={state}&per_page=50&order_by=updated_at"
        );
        let mrs: Vec<ApiMr> = get_json(&url, &token)?;
        Ok(mrs.into_iter().map(ApiMr::into_summary).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr(path: String, iid: u64) -> Result<MergeRequestDetail> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token()?;
        let project = project(&path)?;
        let url = format!("{API_BASE}/projects/{project}/merge_requests/{iid}");
        let mr: ApiMr = get_json(&url, &token)?;
        Ok(mr.into_detail())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_diff(path: String, iid: u64) -> Result<Vec<MrDiffFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token()?;
        let project = project(&path)?;
        let url = format!("{API_BASE}/projects/{project}/merge_requests/{iid}/diffs?per_page=100");
        let diffs: Vec<ApiDiff> = get_json(&url, &token)?;
        Ok(diffs
            .into_iter()
            .map(|d| {
                let new_path = d.new_path.unwrap_or_default();
                MrDiffFile {
                    old_path: d.old_path.unwrap_or_else(|| new_path.clone()),
                    new_path,
                    diff: d.diff.unwrap_or_default(),
                    new_file: d.new_file.unwrap_or(false),
                    renamed_file: d.renamed_file.unwrap_or(false),
                    deleted_file: d.deleted_file.unwrap_or(false),
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn gitlab_mr_notes(path: String, iid: u64) -> Result<Vec<MrNote>> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = token()?;
        let project = project(&path)?;
        let url =
            format!("{API_BASE}/projects/{project}/merge_requests/{iid}/notes?per_page=100&sort=asc");
        let notes: Vec<ApiNote> = get_json(&url, &token)?;
        Ok(notes
            .into_iter()
            .map(|n| MrNote {
                id: n.id,
                author_name: n
                    .author
                    .and_then(|a| a.name)
                    .unwrap_or_default(),
                body: n.body.unwrap_or_default(),
                created_at: n.created_at.unwrap_or_default(),
                system: n.system.unwrap_or(false),
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_from_ssh_remotes() {
        assert_eq!(
            gitlab_slug("git@gitlab.com:acme/web.git").as_deref(),
            Some("acme/web")
        );
        assert_eq!(
            gitlab_slug("ssh://git@gitlab.com:22/acme/web.git").as_deref(),
            Some("acme/web")
        );
    }

    #[test]
    fn slug_from_https_remotes() {
        assert_eq!(
            gitlab_slug("https://gitlab.com/acme/web.git").as_deref(),
            Some("acme/web")
        );
        assert_eq!(
            gitlab_slug("https://gitlab.com/acme/web/").as_deref(),
            Some("acme/web")
        );
        assert_eq!(
            gitlab_slug("https://user:pass@gitlab.com/acme/web.git").as_deref(),
            Some("acme/web")
        );
    }

    #[test]
    fn slug_keeps_nested_groups_and_case() {
        assert_eq!(
            gitlab_slug("git@gitlab.com:Acme/Team/Sub/Web.git").as_deref(),
            Some("Acme/Team/Sub/Web")
        );
        assert_eq!(
            gitlab_slug("https://gitlab.com/acme/team/sub/web").as_deref(),
            Some("acme/team/sub/web")
        );
    }

    #[test]
    fn slug_rejects_other_hosts_and_malformed_remotes() {
        assert_eq!(gitlab_slug("git@github.com:acme/web.git"), None);
        assert_eq!(gitlab_slug("https://github.com/acme/web.git"), None);
        assert_eq!(gitlab_slug("https://gitlab.example.com/acme/web.git"), None);
        assert_eq!(gitlab_slug("https://gitlab.com/acme"), None);
        assert_eq!(gitlab_slug("not-a-url"), None);
    }

    #[test]
    fn encodes_path_separators() {
        assert_eq!(encode_path("group/sub/repo"), "group%2Fsub%2Frepo");
        assert_eq!(encode_path("acme/web"), "acme%2Fweb");
        assert_eq!(encode_path("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode_path("my group/re po"), "my%20group%2Fre%20po");
    }

    #[test]
    fn state_filter_is_allowlisted() {
        for s in ["opened", "merged", "closed", "all"] {
            assert_eq!(valid_state(s).unwrap(), s);
        }
        assert!(valid_state("locked").is_err());
    }
}
