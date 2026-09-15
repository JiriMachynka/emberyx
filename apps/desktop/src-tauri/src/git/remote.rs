use std::path::{Path, PathBuf};
use std::process::Command;

use super::{failure, git, run_git};
use crate::error::{blocking, Error, Result};

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
    let parent = dest
        .parent()
        .ok_or_else(|| Error::new("Destination has no parent directory."))?;
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
    blocking(move || clone_into(url, destination)).await
}

/// `remote.origin.url` for the repo at `cwd`, if it has one.
pub(crate) fn remote_url(cwd: &str) -> Option<String> {
    let out = git(cwd, &["config", "--get", "remote.origin.url"]).ok()?;
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

/// Web base URL for a git remote (`https://github.com/owner/repo`) — the
/// remote without its scheme, credentials, port and `.git` suffix. scp-form
/// remotes become https, which is what a browser link needs.
fn remote_web_base(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    let (authority, path) = match s.find("://") {
        Some(i) => {
            let after = &s[i + 3..];
            let cut = after.find('/')?;
            (&after[..cut], &after[cut..])
        }
        None => {
            let cut = s.find(':')?;
            (&s[..cut], &s[cut + 1..])
        }
    };
    let host = authority.rsplit('@').next()?.split(':').next()?;
    let path = path.trim_start_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    (!host.is_empty() && !path.is_empty()).then(|| format!("https://{host}/{path}"))
}

/// The hosted web page for the repo's HEAD commit, when the origin remote is
/// on Github or Gitlab. Another host has no known page shape — no link beats
/// a wrong link.
pub(crate) fn head_commit_web_url(path: &str) -> Option<String> {
    let sha = run_git(path, &["rev-parse", "HEAD"]).ok()?;
    let raw = remote_url(path)?;
    let base = remote_web_base(&raw)?;
    let host = parse_remote_host(&raw)?;
    if !host.contains("github") && !host.contains("gitlab") {
        return None;
    }
    // Gitlab keeps its repository pages under a `-/` prefix; Github does not.
    let sep = if host.contains("gitlab") {
        "/-/commit/"
    } else {
        "/commit/"
    };
    Some(format!("{base}{sep}{sha}"))
}

pub fn git_head_commit_url(path: String) -> Result<Option<String>> {
    Ok(head_commit_web_url(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::Repo;

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
    fn remote_web_base_strips_scheme_creds_port_and_git_suffix() {
        assert_eq!(
            remote_web_base("https://github.com/owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo")
        );
        // scp-form.
        assert_eq!(
            remote_web_base("git@github.com:owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo")
        );
        // Credentials and port survive in the host parse.
        assert_eq!(
            remote_web_base("https://user@gitlab.com:443/group/sub/repo.git").as_deref(),
            Some("https://gitlab.com/group/sub/repo")
        );
        // No .git suffix is fine.
        assert_eq!(
            remote_web_base("https://github.com/owner/repo").as_deref(),
            Some("https://github.com/owner/repo")
        );
        assert_eq!(remote_web_base(""), None);
    }

    #[test]
    fn head_commit_web_url_uses_the_forges_own_page_shape() {
        let repo = Repo::new("head_commit_url");
        repo.write("a.txt", "hi");
        repo.commit("init");
        repo.run(&["remote", "add", "origin", "https://github.com/owner/repo.git"]);
        let sha = repo.run(&["rev-parse", "HEAD"]);
        assert_eq!(
            head_commit_web_url(repo.path().as_str()),
            Some(format!("https://github.com/owner/repo/commit/{sha}"))
        );
        repo.run(&["remote", "set-url", "origin", "git@gitlab.com:g/r.git"]);
        assert_eq!(
            head_commit_web_url(repo.path().as_str()),
            Some(format!("https://gitlab.com/g/r/-/commit/{sha}"))
        );
        // An unknown host gets no link rather than a guessed one.
        repo.run(&["remote", "set-url", "origin", "git@example.com:o/r.git"]);
        assert_eq!(head_commit_web_url(repo.path().as_str()), None);
        // No remote at all.
        repo.run(&["remote", "remove", "origin"]);
        assert_eq!(head_commit_web_url(repo.path().as_str()), None);
    }
}
