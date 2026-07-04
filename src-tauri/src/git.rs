use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Path relative to the repo root.
    pub path: String,
    /// Two-char porcelain status (e.g. " M", "??", "A ").
    pub status: String,
    pub untracked: bool,
}

fn is_repo(path: &str) -> bool {
    Command::new("git")
        .args(["-C", path, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List working-tree changes (staged, unstaged, untracked).
#[tauri::command]
pub fn git_changes(path: String) -> Result<Vec<GitFile>, String> {
    if !is_repo(&path) {
        return Ok(vec![]);
    }
    let out = Command::new("git")
        .args(["-C", &path, "status", "--porcelain=v1"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut files = vec![];
    for line in text.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[0..2].to_string();
        let mut path_part = line[3..].to_string();
        // Renames appear as "old -> new"; show the new path.
        if let Some(idx) = path_part.find(" -> ") {
            path_part = path_part[idx + 4..].to_string();
        }
        files.push(GitFile {
            untracked: status == "??",
            path: path_part,
            status,
        });
    }
    Ok(files)
}

/// Unified diff for one file (or the whole file's contents if untracked).
#[tauri::command]
pub fn git_file_diff(path: String, file: String, untracked: bool) -> Result<String, String> {
    if untracked {
        let content =
            std::fs::read_to_string(Path::new(&path).join(&file)).unwrap_or_default();
        return Ok(content
            .lines()
            .map(|l| format!("+{}", l))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    // Diff working tree against HEAD; fall back to the index diff if there's
    // no HEAD yet (fresh repo).
    let run = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .map_err(|e| e.to_string())
    };
    let out = run(&["-C", &path, "diff", "HEAD", "--no-color", "--", &file])?;
    if out.status.success() && !out.stdout.is_empty() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let fallback = run(&["-C", &path, "diff", "--no-color", "--", &file])?;
    Ok(String::from_utf8_lossy(&fallback.stdout).to_string())
}

/// Stage the selected files and commit only those paths with `message`.
#[tauri::command]
pub fn git_commit(path: String, files: Vec<String>, message: String) -> Result<String, String> {
    if !is_repo(&path) {
        return Err("Not a git repository.".into());
    }
    if files.is_empty() {
        return Err("No files selected.".into());
    }
    if message.trim().is_empty() {
        return Err("Commit message is empty.".into());
    }

    // Stage the selected files (picks up untracked ones too).
    let mut add = vec!["-C", &path, "add", "--"];
    add.extend(files.iter().map(|f| f.as_str()));
    let out = Command::new("git")
        .args(&add)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    // Commit only the selected paths, even if other changes were pre-staged.
    let mut commit = vec!["-C", &path, "commit", "-m", &message, "--"];
    commit.extend(files.iter().map(|f| f.as_str()));
    let out = Command::new("git")
        .args(&commit)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!("{}{}", stdout, err).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
