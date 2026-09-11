use std::path::{Path, PathBuf};
use std::process::Command;

use super::{failure, git};
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
}
