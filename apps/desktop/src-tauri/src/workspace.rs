use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// A single runnable package (has a dev-ish script).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    /// package.json "name", or the directory name as fallback.
    pub name: String,
    /// Path relative to the project root, for display (e.g. "apps/web").
    pub rel_path: String,
    /// Absolute path the dev command runs in.
    pub path: String,
    /// Full command to run, e.g. "bun run dev".
    pub dev_command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// "turbo" | "pnpm" | "npm" | "single"
    pub kind: String,
    /// "bun" | "pnpm" | "yarn" | "npm"
    pub package_manager: String,
    /// Runnable packages.
    pub packages: Vec<PackageInfo>,
    /// Command to run everything at once (root "dev" script), if one exists.
    pub all_command: Option<String>,
}

const DEV_SCRIPTS: [&str; 3] = ["dev", "start", "serve"];

fn detect_package_manager(root: &Path) -> String {
    if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
        "bun".into()
    } else if root.join("pnpm-lock.yaml").exists() {
        "pnpm".into()
    } else if root.join("yarn.lock").exists() {
        "yarn".into()
    } else if root.join("package-lock.json").exists() {
        "npm".into()
    } else {
        "npm".into()
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Pick the first present dev-ish script name from a package.json.
fn pick_dev_script(pkg: &Value) -> Option<String> {
    let scripts = pkg.get("scripts")?.as_object()?;
    DEV_SCRIPTS
        .iter()
        .find(|s| scripts.contains_key(**s))
        .map(|s| s.to_string())
}

fn run_command(pm: &str, script: &str) -> String {
    // bun/pnpm/yarn/npm all accept `<pm> run <script>`.
    format!("{} run {}", pm, script)
}

/// Read the workspace globs from pnpm-workspace.yaml (minimal parser for the
/// common `packages:\n  - "glob"` shape).
fn pnpm_globs(root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join("pnpm-workspace.yaml")) else {
        return vec![];
    };
    let mut globs = vec![];
    let mut in_packages = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("packages:") {
            in_packages = true;
            continue;
        }
        if in_packages {
            if let Some(rest) = trimmed.strip_prefix("- ") {
                globs.push(rest.trim().trim_matches(['"', '\'']).to_string());
            } else if !trimmed.is_empty() && !line.starts_with([' ', '\t', '-']) {
                break; // next top-level key
            }
        }
    }
    globs
}

/// Read workspace globs from package.json "workspaces" (array or { packages }).
fn package_json_globs(pkg: &Value) -> Vec<String> {
    let ws = match pkg.get("workspaces") {
        Some(v) => v,
        None => return vec![],
    };
    let arr = ws
        .as_array()
        .or_else(|| ws.get("packages").and_then(|p| p.as_array()));
    arr.map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    })
    .unwrap_or_default()
}

/// Expand a workspace glob (relative to root) into package directories that
/// contain a package.json.
fn expand_glob(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let full = root.join(pattern);
    let Some(pattern_str) = full.to_str() else {
        return vec![];
    };
    let mut dirs = vec![];
    if let Ok(paths) = glob::glob(pattern_str) {
        for entry in paths.flatten() {
            if entry.is_dir() && entry.join("package.json").exists() {
                dirs.push(entry);
            }
        }
    }
    dirs
}

fn package_from_dir(root: &Path, dir: &Path, pm: &str) -> Option<PackageInfo> {
    let pkg = read_json(&dir.join("package.json"))?;
    let script = pick_dev_script(&pkg)?;
    let name = pkg
        .get("name")
        .and_then(|n| n.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            dir.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("package")
                .to_string()
        });
    let rel_path = dir
        .strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .unwrap_or(".")
        .to_string();
    Some(PackageInfo {
        name,
        rel_path: if rel_path.is_empty() { ".".into() } else { rel_path },
        path: dir.to_string_lossy().to_string(),
        dev_command: run_command(pm, &script),
    })
}

pub fn scan(root_str: &str) -> Result<WorkspaceInfo, String> {
    let root = PathBuf::from(root_str);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root_str));
    }

    let pm = detect_package_manager(&root);
    let root_pkg = read_json(&root.join("package.json"));

    // Collect workspace globs.
    let has_turbo = root.join("turbo.json").exists();
    let has_pnpm_ws = root.join("pnpm-workspace.yaml").exists();
    let mut globs = pnpm_globs(&root);
    if globs.is_empty() {
        if let Some(pkg) = &root_pkg {
            globs = package_json_globs(pkg);
        }
    }

    let kind = if has_turbo {
        "turbo"
    } else if has_pnpm_ws {
        "pnpm"
    } else if !globs.is_empty() {
        "npm"
    } else {
        "single"
    }
    .to_string();

    // Expand packages.
    let mut packages: Vec<PackageInfo> = vec![];
    let mut seen = std::collections::HashSet::new();
    for pattern in &globs {
        for dir in expand_glob(&root, pattern) {
            if seen.insert(dir.clone()) {
                if let Some(info) = package_from_dir(&root, &dir, &pm) {
                    packages.push(info);
                }
            }
        }
    }

    // Single-package project: use the root itself.
    if packages.is_empty() {
        if let Some(info) = root_pkg
            .as_ref()
            .and_then(|_| package_from_dir(&root, &root, &pm))
        {
            packages.push(info);
        }
    }

    packages.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    // "All" command = root dev script, if present.
    let all_command = root_pkg
        .as_ref()
        .and_then(pick_dev_script)
        .map(|s| run_command(&pm, &s));

    Ok(WorkspaceInfo {
        kind,
        package_manager: pm,
        packages,
        all_command,
    })
}

#[tauri::command]
pub fn scan_workspace(path: String) -> Result<WorkspaceInfo, String> {
    scan(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn detects_turbo_monorepo() {
        let root = std::env::temp_dir().join("emberyx_test_turbo");
        let _ = std::fs::remove_dir_all(&root);

        write(&root.join("turbo.json"), "{}");
        write(&root.join("bun.lock"), "");
        write(
            &root.join("package.json"),
            r#"{"name":"repo","workspaces":["apps/*","packages/*"],"scripts":{"dev":"turbo run dev"}}"#,
        );
        write(
            &root.join("apps/web/package.json"),
            r#"{"name":"web","scripts":{"dev":"vite"}}"#,
        );
        write(
            &root.join("apps/api/package.json"),
            r#"{"name":"@repo/api","scripts":{"start":"node index.js"}}"#,
        );
        write(
            &root.join("packages/ui/package.json"),
            r#"{"name":"ui","scripts":{"build":"tsc"}}"#,
        );

        let info = scan(root.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "turbo");
        assert_eq!(info.package_manager, "bun");
        // web (dev) + api (start) are runnable; ui (no dev-ish script) is skipped.
        assert_eq!(info.packages.len(), 2);
        let web = info.packages.iter().find(|p| p.name == "web").unwrap();
        assert_eq!(web.dev_command, "bun run dev");
        assert_eq!(web.rel_path, "apps/web");
        let api = info.packages.iter().find(|p| p.name == "@repo/api").unwrap();
        assert_eq!(api.dev_command, "bun run start");
        assert_eq!(info.all_command.as_deref(), Some("bun run dev"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detects_pnpm_workspace() {
        let root = std::env::temp_dir().join("emberyx_test_pnpm");
        let _ = std::fs::remove_dir_all(&root);

        write(&root.join("pnpm-lock.yaml"), "");
        write(
            &root.join("pnpm-workspace.yaml"),
            "packages:\n  - \"apps/*\"\n",
        );
        write(&root.join("package.json"), r#"{"name":"repo"}"#);
        write(
            &root.join("apps/site/package.json"),
            r#"{"name":"site","scripts":{"dev":"next dev"}}"#,
        );

        let info = scan(root.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "pnpm");
        assert_eq!(info.package_manager, "pnpm");
        assert_eq!(info.packages.len(), 1);
        assert_eq!(info.packages[0].dev_command, "pnpm run dev");
        assert_eq!(info.all_command, None); // root has no dev script

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detects_single_package() {
        let root = std::env::temp_dir().join("emberyx_test_single");
        let _ = std::fs::remove_dir_all(&root);

        write(&root.join("package-lock.json"), "");
        write(
            &root.join("package.json"),
            r#"{"name":"solo","scripts":{"dev":"vite"}}"#,
        );

        let info = scan(root.to_str().unwrap()).unwrap();
        assert_eq!(info.kind, "single");
        assert_eq!(info.package_manager, "npm");
        assert_eq!(info.packages.len(), 1);
        assert_eq!(info.packages[0].name, "solo");
        assert_eq!(info.packages[0].rel_path, ".");
        assert_eq!(info.packages[0].dev_command, "npm run dev");

        let _ = std::fs::remove_dir_all(&root);
    }
}
