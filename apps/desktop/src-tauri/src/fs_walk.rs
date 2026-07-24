use std::ops::ControlFlow;
use std::path::Path;

/// Directories never worth showing or scanning: VCS metadata, dependency
/// trees, and build output.
pub const SKIP_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".nuxt",
    ".turbo",
    ".output",
    "build",
];

/// Whether a directory should be skipped. `skip_hidden` also drops dot-dirs,
/// which recursive scans want but a browsable tree does not.
pub fn is_noise_dir(name: &str, skip_hidden: bool) -> bool {
    SKIP_DIRS.contains(&name) || (skip_hidden && name.starts_with('.'))
}

/// Depth-first walk over every file under `root`, skipping noise directories.
/// `visit` returns `ControlFlow::Break` to stop the walk early (hit a cap,
/// found enough matches); the break propagates all the way out.
pub fn walk_files(
    root: &Path,
    visit: &mut impl FnMut(&Path) -> ControlFlow<()>,
) -> ControlFlow<()> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return ControlFlow::Continue(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_noise_dir(&name, true) {
                continue;
            }
            walk_files(&path, visit)?;
        } else {
            if entry.file_name() == ".git" {
                continue;
            }
            visit(&path)?;
        }
    }
    ControlFlow::Continue(())
}

/// A file's lowercase extension, or "" when it has none.
pub fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_files_and_skips_noise() {
        let root = std::env::temp_dir().join("emberyx_test_walk");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join(".cache")).unwrap();
        std::fs::write(root.join("src/a.ts"), "").unwrap();
        std::fs::write(root.join("node_modules/b.ts"), "").unwrap();
        std::fs::write(root.join(".cache/c.ts"), "").unwrap();
        std::fs::write(root.join(".git"), "gitdir: /elsewhere").unwrap();

        let mut seen = vec![];
        let _ = walk_files(&root, &mut |p| {
            seen.push(p.file_name().unwrap().to_string_lossy().to_string());
            ControlFlow::Continue(())
        });
        assert_eq!(seen, vec!["a.ts"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn break_stops_the_walk() {
        let root = std::env::temp_dir().join("emberyx_test_walk_break");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        for name in ["1.ts", "2.ts", "3.ts"] {
            std::fs::write(root.join("a/b").join(name), "").unwrap();
        }

        let mut count = 0;
        let _ = walk_files(&root, &mut |_| {
            count += 1;
            if count == 2 {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        });
        assert_eq!(count, 2);

        let _ = std::fs::remove_dir_all(&root);
    }
}
