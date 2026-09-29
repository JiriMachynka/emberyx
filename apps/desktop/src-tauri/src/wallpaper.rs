//! The custom window background: one image, copied into the app data dir so it
//! survives the original being moved or deleted.
//!
//! The webview reads it back as bytes (`wallpaper_read`) and paints it from a
//! blob URL, which keeps the asset protocol — and the file-system scope it
//! needs — out of a webview that was deliberately locked down.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::err;
use crate::error::Result;

const EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
const PREFIX: &str = "wallpaper-";

/// The whole file crosses IPC and is decoded by the webview; refuse what would
/// stall it.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

fn extension_of(path: &Path) -> Result<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(err!("not a supported image: use png, jpg or webp"))
    }
}

/// True for a name `import` could have produced. `read` takes the name from
/// the webview, so this is what keeps it from being a path.
fn is_wallpaper_name(name: &str) -> bool {
    Path::new(name).file_name().and_then(|f| f.to_str()) == Some(name)
        && name.starts_with(PREFIX)
        && extension_of(Path::new(name)).is_ok()
}

fn stale_files(dir: &Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(is_wallpaper_name))
        .map(|e| e.path())
        .collect()
}

/// Copy `source` in and drop the previous image. The name is timestamped so
/// replacing a `.png` with another `.png` still changes the setting — the
/// frontend re-reads only when the name moves.
fn import(dir: &Path, source: &Path) -> Result<String> {
    let ext = extension_of(source)?;
    if std::fs::metadata(source)?.len() > MAX_BYTES {
        return Err(err!("image is larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    std::fs::create_dir_all(dir)?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let name = format!("{PREFIX}{millis}.{ext}");
    // Copy before deleting, so a failed copy never costs the image in use.
    std::fs::copy(source, dir.join(&name))?;
    for old in stale_files(dir) {
        if old.file_name().and_then(|f| f.to_str()) != Some(name.as_str()) {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(name)
}

fn read(dir: &Path, name: &str) -> Result<Vec<u8>> {
    if !is_wallpaper_name(name) {
        return Err(err!("not a wallpaper: {}", name));
    }
    Ok(std::fs::read(dir.join(name))?)
}

fn clear(dir: &Path) -> Result<()> {
    for file in stale_files(dir) {
        std::fs::remove_file(file)?;
    }
    Ok(())
}

pub mod cmd {
    use super::*;
    use crate::error::blocking;

    fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf> {
        Ok(app.path().app_data_dir()?)
    }

    #[tauri::command]
    pub async fn wallpaper_import(app: AppHandle, source: String) -> Result<String> {
        let dir = data_dir(&app)?;
        blocking(move || import(&dir, Path::new(&source))).await
    }

    #[tauri::command]
    pub async fn wallpaper_read(app: AppHandle, name: String) -> Result<tauri::ipc::Response> {
        let dir = data_dir(&app)?;
        let bytes = blocking(move || read(&dir, &name)).await?;
        Ok(tauri::ipc::Response::new(bytes))
    }

    #[tauri::command]
    pub async fn wallpaper_clear(app: AppHandle) -> Result<()> {
        let dir = data_dir(&app)?;
        blocking(move || clear(&dir)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("emberyx_wallpaper_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn import_copies_and_replaces_the_previous_image() {
        let root = scratch("replace");
        let data = root.join("data");
        let a = root.join("a.PNG");
        let b = root.join("b.jpg");
        std::fs::write(&a, b"one").unwrap();
        std::fs::write(&b, b"two").unwrap();

        let first = import(&data, &a).unwrap();
        assert!(first.ends_with(".png"));
        assert_eq!(read(&data, &first).unwrap(), b"one");

        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = import(&data, &b).unwrap();
        assert_ne!(first, second);
        assert_eq!(read(&data, &second).unwrap(), b"two");
        assert!(read(&data, &first).is_err(), "the old image is dropped");
    }

    #[test]
    fn import_refuses_other_files() {
        let root = scratch("refuse");
        let text = root.join("notes.txt");
        std::fs::write(&text, b"hi").unwrap();
        assert!(import(&root.join("data"), &text).is_err());
    }

    #[test]
    fn read_only_serves_names_import_produced() {
        let root = scratch("names");
        std::fs::write(root.join("secret.png"), b"x").unwrap();
        assert!(read(&root, "secret.png").is_err());
        assert!(read(&root, "../wallpaper-1.png").is_err());
        assert!(read(&root, "wallpaper-1.txt").is_err());
    }

    #[test]
    fn clear_removes_only_wallpapers() {
        let root = scratch("clear");
        std::fs::write(root.join("wallpaper-1.png"), b"x").unwrap();
        std::fs::write(root.join("emberyx.db"), b"keep").unwrap();
        clear(&root).unwrap();
        assert!(!root.join("wallpaper-1.png").exists());
        assert!(root.join("emberyx.db").exists());
    }
}
