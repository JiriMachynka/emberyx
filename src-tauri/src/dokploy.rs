use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DokployService {
    pub name: String,
    /// application | compose | postgres | mysql | mariadb | mongo | redis
    pub kind: String,
    /// Deploy status reported by Dokploy (idle | running | done | error), if any.
    pub status: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DokployMatch {
    /// Name of the Dokploy project that owns the matched service.
    pub project_name: String,
    /// Name of the service whose git repo matched the local remote.
    pub matched_service: String,
    /// All services in that Dokploy project.
    pub services: Vec<DokployService>,
}

const DB_KINDS: [&str; 5] = ["postgres", "mysql", "mariadb", "mongo", "redis"];

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

/// Reduce a git URL to a lowercase `owner/repo` slug for comparison.
/// Handles `https://host/owner/repo(.git)` and scp-form `git@host:owner/repo(.git)`.
fn git_slug(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    let path = if let Some(idx) = s.find("://") {
        // Drop scheme + host, keep the path.
        s[idx + 3..].splitn(2, '/').nth(1).unwrap_or("").to_string()
    } else if let Some(idx) = s.rfind('@') {
        // git@host:owner/repo — keep what follows the first ':'.
        s[idx + 1..].splitn(2, ':').nth(1).unwrap_or("").to_string()
    } else {
        s.to_string()
    };
    let segs: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|x| !x.is_empty())
        .collect();
    (segs.len() >= 2).then(|| {
        format!(
            "{}/{}",
            segs[segs.len() - 2].to_lowercase(),
            segs[segs.len() - 1].to_lowercase()
        )
    })
}

/// Git slug for a Dokploy application/compose object, if it carries git info.
fn service_slug(svc: &Value) -> Option<String> {
    if let Some(u) = svc.get("customGitUrl").and_then(Value::as_str) {
        if !u.is_empty() {
            return git_slug(u);
        }
    }
    let owner = svc.get("owner").and_then(Value::as_str);
    let repo = svc.get("repository").and_then(Value::as_str);
    match (owner, repo) {
        (Some(o), Some(r)) if !o.is_empty() && !r.is_empty() => {
            Some(format!("{}/{}", o.to_lowercase(), r.to_lowercase()))
        }
        _ => None,
    }
}

fn status_of(svc: &Value) -> Option<String> {
    for k in ["applicationStatus", "composeStatus"] {
        if let Some(s) = svc.get(k).and_then(Value::as_str) {
            return Some(s.to_string());
        }
    }
    None
}

/// Collect the services in a project/environment container, flagging the one
/// whose git repo matches `local`.
fn collect(container: &Value, out: &mut Vec<DokployService>, matched: &mut Option<String>, local: &str) {
    for (key, kind) in [("applications", "application"), ("compose", "compose")] {
        if let Some(arr) = container.get(key).and_then(Value::as_array) {
            for svc in arr {
                let name = svc.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                if matched.is_none() && service_slug(svc).as_deref() == Some(local) {
                    *matched = Some(name.clone());
                }
                out.push(DokployService {
                    name,
                    kind: kind.to_string(),
                    status: status_of(svc),
                });
            }
        }
    }
    for kind in DB_KINDS {
        if let Some(arr) = container.get(kind).and_then(Value::as_array) {
            for svc in arr {
                out.push(DokployService {
                    name: svc.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    kind: kind.to_string(),
                    status: status_of(svc),
                });
            }
        }
    }
}

/// Find the Dokploy project deploying the repo at `cwd` (matched by git remote)
/// and return its services. `Ok(None)` if there's no remote or no match.
#[tauri::command]
pub fn dokploy_services(
    url: String,
    api_key: String,
    cwd: String,
) -> Result<Option<DokployMatch>, String> {
    let local = match remote_url(&cwd).as_deref().and_then(git_slug) {
        Some(s) => s,
        None => return Ok(None),
    };
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Dokploy URL not set".into());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(10))
        .build();
    let resp = agent
        .get(&format!("{base}/api/project.all"))
        .set("x-api-key", api_key.trim())
        .set("accept", "application/json")
        .call()
        .map_err(|e| format!("Dokploy request failed: {e}"))?;
    let json: Value = resp.into_json().map_err(|e| e.to_string())?;
    let projects = json.as_array().ok_or("Unexpected Dokploy response")?;

    for project in projects {
        let mut services = vec![];
        let mut matched = None;
        if let Some(envs) = project.get("environments").and_then(Value::as_array) {
            for env in envs {
                collect(env, &mut services, &mut matched, &local);
            }
        } else {
            collect(project, &mut services, &mut matched, &local);
        }
        if let Some(matched_service) = matched {
            return Ok(Some(DokployMatch {
                project_name: project.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                matched_service,
                services,
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_normalize_across_url_forms() {
        assert_eq!(git_slug("git@github.com:Acme/Web.git").as_deref(), Some("acme/web"));
        assert_eq!(git_slug("https://github.com/Acme/Web.git").as_deref(), Some("acme/web"));
        assert_eq!(git_slug("https://gitlab.com/acme/web/").as_deref(), Some("acme/web"));
        assert_eq!(git_slug("ssh://git@host:22/acme/web.git").as_deref(), Some("acme/web"));
        assert_eq!(git_slug("not-a-url"), None);
    }

    #[test]
    fn service_slug_from_owner_repo_and_custom_url() {
        let github = serde_json::json!({ "owner": "Acme", "repository": "Web" });
        assert_eq!(service_slug(&github).as_deref(), Some("acme/web"));
        let custom = serde_json::json!({ "customGitUrl": "git@github.com:Acme/Web.git" });
        assert_eq!(service_slug(&custom).as_deref(), Some("acme/web"));
    }
}
