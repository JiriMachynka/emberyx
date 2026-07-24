use std::path::Path;

use base64::Engine;

/// Common locations projects keep a favicon / logo, in priority order.
const CANDIDATES: [&str; 15] = [
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "public/logo.svg",
    "public/logo.png",
    "public/apple-touch-icon.png",
    "static/favicon.svg",
    "static/favicon.ico",
    "static/favicon.png",
    "app/favicon.ico",
    "src/favicon.ico",
    "assets/logo.svg",
    "assets/logo.png",
    "favicon.ico",
    "favicon.png",
];

/// Tauri desktop apps keep their real app icon here — the best source when a
/// repo has no web favicon (checked after the web candidates above).
const TAURI_ICONS: [&str; 2] = ["src-tauri/icons/128x128.png", "src-tauri/icons/icon.png"];

/// Monorepos keep each app's icon under a workspace subdir, not the repo root.
const WORKSPACE_DIRS: [&str; 2] = ["apps", "packages"];

/// Skip anything larger than this — a data URL for a giant image is wasteful.
const MAX_BYTES: u64 = 512 * 1024;

fn mime_for(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("svg") => Some("image/svg+xml"),
        Some("png") => Some("image/png"),
        Some("ico") => Some("image/x-icon"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        _ => None,
    }
}

/// The first present candidate directly under `dir`, as a `data:` URL.
fn find_in(dir: &Path) -> Option<String> {
    for rel in CANDIDATES.iter().chain(TAURI_ICONS.iter()) {
        let path = dir.join(rel);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_BYTES {
            continue;
        }
        let Some(mime) = mime_for(&path) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{};base64,{}", mime, encoded));
    }
    None
}

/// Find a project icon as a `data:` URL, or `None`. Checks the repo root first,
/// then — for monorepos, whose icons live under `apps/*` or `packages/*` — the
/// first workspace member that has one (sorted, so the result is stable).
pub fn find(root_str: &str) -> Option<String> {
    let root = Path::new(root_str);
    if let Some(icon) = find_in(root) {
        return Some(icon);
    }
    for workspace in WORKSPACE_DIRS {
        let Ok(entries) = std::fs::read_dir(root.join(workspace)) else {
            continue;
        };
        let mut members: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        members.sort();
        for member in members {
            if let Some(icon) = find_in(&member) {
                return Some(icon);
            }
        }
    }
    None
}

#[tauri::command]
pub fn project_icon(path: String) -> Option<String> {
    find(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("emberyx-icon-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn write_png(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A 1×1 PNG is enough — find() only reads bytes, it doesn't decode.
        fs::write(path, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
    }

    #[test]
    fn finds_a_root_favicon() {
        let root = scratch("root");
        write_png(&root.join("public/favicon.png"));
        assert!(find(root.to_str().unwrap())
            .unwrap()
            .starts_with("data:image/png;base64,"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn finds_a_monorepo_tauri_icon() {
        let root = scratch("mono");
        // No root icon; the app's Tauri icon lives a workspace level down.
        write_png(&root.join("apps/desktop/src-tauri/icons/128x128.png"));
        assert!(find(root.to_str().unwrap()).is_some());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn none_when_no_icon_anywhere() {
        let root = scratch("bare");
        fs::create_dir_all(root.join("apps/desktop/src")).unwrap();
        assert!(find(root.to_str().unwrap()).is_none());
        fs::remove_dir_all(&root).unwrap();
    }
}
