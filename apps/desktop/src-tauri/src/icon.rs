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

/// Find the first present icon candidate and return it as a `data:` URL, or
/// `None` if the project has no recognizable icon.
pub fn find(root_str: &str) -> Option<String> {
    let root = Path::new(root_str);
    for rel in CANDIDATES {
        let path = root.join(rel);
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

#[tauri::command]
pub fn project_icon(path: String) -> Option<String> {
    find(&path)
}
