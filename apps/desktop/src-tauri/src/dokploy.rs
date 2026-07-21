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
    /// Dokploy service id used for actions (applicationId/composeId); None for databases.
    pub id: Option<String>,
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

/// Collect the services (apps, compose, databases) in a project/environment
/// container, capturing name/kind/status/id from the slim `project.all` shape.
fn collect(container: &Value, out: &mut Vec<DokployService>) {
    for (key, kind, id_field) in [
        ("applications", "application", "applicationId"),
        ("compose", "compose", "composeId"),
    ] {
        if let Some(arr) = container.get(key).and_then(Value::as_array) {
            for svc in arr {
                out.push(DokployService {
                    name: svc.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    kind: kind.to_string(),
                    status: status_of(svc),
                    id: svc.get(id_field).and_then(Value::as_str).map(str::to_string),
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
                    id: None,
                });
            }
        }
    }
}

/// A git-backed service whose repo slug must be resolved via a detail fetch.
struct Candidate {
    project_index: usize,
    kind: &'static str,
    id: String,
    name: String,
}

/// The environment containers of a project (or the project itself as fallback).
fn containers_of(project: &Value) -> Vec<&Value> {
    match project.get("environments").and_then(Value::as_array) {
        Some(envs) => envs.iter().collect(),
        None => vec![project],
    }
}

/// Fetch a service's full detail and derive its git slug. `project.all` omits
/// git fields, so matching requires this per-service `*.one` call.
fn detail_slug(agent: &ureq::Agent, base: &str, api_key: &str, kind: &str, id: &str) -> Option<String> {
    let (path, param) = match kind {
        "application" => ("application.one", "applicationId"),
        "compose" => ("compose.one", "composeId"),
        _ => return None,
    };
    let detail: Value = agent
        .get(&format!("{base}/api/{path}?{param}={id}"))
        .set("x-api-key", api_key)
        .set("accept", "application/json")
        .call()
        .ok()?
        .into_json()
        .ok()?;
    service_slug(&detail)
}

/// Find the Dokploy project deploying the repo at `cwd` (matched by git remote)
/// and return its services. `Ok(None)` if there's no remote or no match.
#[tauri::command]
pub async fn dokploy_services(
    url: String,
    api_key: String,
    cwd: String,
) -> Result<Option<DokployMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let local = match remote_url(&cwd).as_deref().and_then(git_slug) {
            Some(s) => s,
            None => return Ok(None),
        };
        let base = url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Dokploy URL not set".into());
        }
        let api_key = api_key.trim();
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(10))
            .build();
        let resp = agent
            .get(&format!("{base}/api/project.all"))
            .set("x-api-key", api_key)
            .set("accept", "application/json")
            .call()
            .map_err(|e| format!("Dokploy request failed: {e}"))?;
        let json: Value = resp.into_json().map_err(|e| e.to_string())?;
        let projects = json.as_array().ok_or("Unexpected Dokploy response")?;

        // Services per project (slim), plus the git-backed candidates to resolve.
        let mut per_project: Vec<(String, Vec<DokployService>)> = Vec::with_capacity(projects.len());
        let mut candidates: Vec<Candidate> = vec![];
        for (project_index, project) in projects.iter().enumerate() {
            let mut services = vec![];
            for container in containers_of(project) {
                collect(container, &mut services);
                for (key, kind, id_field) in [
                    ("applications", "application", "applicationId"),
                    ("compose", "compose", "composeId"),
                ] {
                    if let Some(arr) = container.get(key).and_then(Value::as_array) {
                        for svc in arr {
                            if let Some(id) = svc.get(id_field).and_then(Value::as_str) {
                                candidates.push(Candidate {
                                    project_index,
                                    kind,
                                    id: id.to_string(),
                                    name: svc.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                                });
                            }
                        }
                    }
                }
            }
            let name = project.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            per_project.push((name, services));
        }

        // Resolve slugs concurrently (git fields require a detail call each) and
        // take the first candidate matching the local repo.
        let workers = candidates.len().clamp(1, 12);
        let chunk_size = candidates.len().div_ceil(workers).max(1);
        let matched: Option<(usize, String)> = std::thread::scope(|scope| {
            let handles: Vec<_> = candidates
                .chunks(chunk_size)
                .map(|chunk| {
                    scope.spawn(|| {
                        chunk
                            .iter()
                            .filter(|c| {
                                detail_slug(&agent, base, api_key, c.kind, &c.id).as_deref()
                                    == Some(local.as_str())
                            })
                            .map(|c| (c.project_index, c.name.clone()))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).next()
        });

        if let Some((project_index, matched_service)) = matched {
            let (project_name, services) = &mut per_project[project_index];
            return Ok(Some(DokployMatch {
                project_name: std::mem::take(project_name),
                matched_service,
                services: std::mem::take(services),
            }));
        }
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Trigger a redeploy of a Dokploy application or compose service.
#[tauri::command]
pub async fn dokploy_redeploy(url: String, api_key: String, kind: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Dokploy URL not set".into());
        }
        let (path, body) = match kind.as_str() {
            "application" => ("application.redeploy", serde_json::json!({ "applicationId": id })),
            "compose" => ("compose.redeploy", serde_json::json!({ "composeId": id })),
            other => return Err(format!("Cannot redeploy {other}")),
        };
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(10))
            .build();
        agent
            .post(&format!("{base}/api/{path}"))
            .set("x-api-key", api_key.trim())
            .set("content-type", "application/json")
            .send_json(body)
            .map_err(|e| format!("Dokploy redeploy failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read recent logs for a Dokploy application. Only `application` is supported.
#[tauri::command]
pub async fn dokploy_logs(url: String, api_key: String, kind: String, id: String, tail: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if kind != "application" {
            return Err(format!("Logs not supported for {kind}"));
        }
        let base = url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Dokploy URL not set".into());
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(10))
            .build();
        let resp = agent
            .get(&format!("{base}/api/application.readLogs?applicationId={id}&tail={tail}&since=all"))
            .set("x-api-key", api_key.trim())
            .set("accept", "application/json")
            .call()
            .map_err(|e| format!("Dokploy logs failed: {e}"))?;
        let body = resp.into_string().map_err(|e| format!("Dokploy logs failed: {e}"))?;
        // Endpoint may return a raw string or a JSON-encoded (quoted) string.
        Ok(serde_json::from_str::<String>(&body).unwrap_or(body))
    })
    .await
    .map_err(|e| e.to_string())?
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
