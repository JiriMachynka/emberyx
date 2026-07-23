use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::err;
use crate::error::Result;
use crate::fs_walk::{is_noise_dir, walk_files};

/// One entry in a listed directory.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Absolute path.
    pub path: String,
    pub is_dir: bool,
}

/// Files bigger than this are refused — the editor holds the whole buffer in
/// the webview and highlights it in one pass.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Ceiling on the flat file list handed to the finder.
const MAX_LISTED: usize = 20_000;

/// List a directory: directories first, then files, each alphabetical. Dot
/// entries are kept — `.env` and `.gitignore` are worth editing.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(err!("not a directory: {}", path));
    }
    let mut entries: Vec<DirEntry> = vec![];
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && is_noise_dir(&name, false) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Every file under `path`, as paths relative to it — the corpus the editor's
/// ⌘K finder fuzzy-matches against.
#[tauri::command]
pub async fn list_files(path: String) -> Result<Vec<String>> {
    // Off the main thread: a full walk of a big repo would stall the UI.
    Ok(tauri::async_runtime::spawn_blocking(move || walk_list(path))
        .await
        .map_err(|e| e.to_string())??)
}

fn walk_list(path: String) -> Result<Vec<String>> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(err!("not a directory: {}", path));
    }
    let mut out: Vec<String> = vec![];
    let _ = walk_files(&root, &mut |file| {
        if out.len() >= MAX_LISTED {
            return ControlFlow::Break(());
        }
        if let Ok(rel) = file.strip_prefix(&root) {
            out.push(rel.to_string_lossy().to_string());
        }
        ControlFlow::Continue(())
    });
    out.sort();
    Ok(out)
}

/// True if the first chunk of a file looks binary (contains a NUL byte).
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

/// Read a UTF-8 text file. Errors on binary content or oversized files so the
/// editor can show a message instead of choking on the buffer.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String> {
    let file = Path::new(&path);
    let meta = std::fs::metadata(file)?;
    if meta.len() > MAX_BYTES {
        return Err(err!(
            "file too large ({} KB) — open it in an external editor",
            meta.len() / 1024
        ));
    }
    let bytes = std::fs::read(file)?;
    if looks_binary(&bytes) {
        return Err(err!("binary file"));
    }
    Ok(String::from_utf8(bytes)?)
}

/// Overwrite a file with new text.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<()> {
    Ok(std::fs::write(Path::new(&path), contents)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_dirs_first_and_skips_noise() {
        let root = std::env::temp_dir().join("emberyx_test_files");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("a.txt"), "hello").unwrap();

        let entries = list_dir(root.to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "a.txt"]);

        let text = read_text_file(root.join("a.txt").to_string_lossy().to_string()).unwrap();
        assert_eq!(text, "hello");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_files_recursively_relative_to_root() {
        let root = std::env::temp_dir().join("emberyx_test_list_files");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src/lib/utils.ts"), "").unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "").unwrap();

        let files = walk_list(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(files, vec!["README.md", "src/lib/utils.ts"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_binary() {
        let root = std::env::temp_dir().join("emberyx_test_files_bin");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("b.bin"), [0x00, 0x01, 0x02]).unwrap();

        let err = read_text_file(root.join("b.bin").to_string_lossy().to_string()).unwrap_err();
        assert_eq!(err.to_string(), "binary file");

        let _ = std::fs::remove_dir_all(&root);
    }
}
