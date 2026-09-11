use super::{git, GitFile};

/// A throwaway repo with deterministic identity and no global config
/// leaking in (signing, hooks, and templates all vary per machine).
pub(super) struct Repo(pub(super) std::path::PathBuf);

impl Repo {
    pub(super) fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("emberyx_test_git_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repo(dir);
        repo.run(&["init", "-b", "main"]);
        repo.run(&["config", "user.email", "test@emberyx.dev"]);
        repo.run(&["config", "user.name", "Emberyx Test"]);
        repo.run(&["config", "commit.gpgsign", "false"]);
        repo.run(&["config", "core.hooksPath", "/nonexistent"]);
        repo
    }

    pub(super) fn path(&self) -> String {
        self.0.to_string_lossy().to_string()
    }

    /// Raw git, for arranging state the module under test isn't asserting on.
    pub(super) fn run(&self, args: &[&str]) -> String {
        let out = git(&self.path(), args).unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    pub(super) fn write(&self, file: &str, contents: &str) {
        let path = self.0.join(file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    pub(super) fn commit(&self, message: &str) {
        self.run(&["add", "-A"]);
        self.run(&["commit", "-m", message]);
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        // Worktrees land beside the repo, not inside it, so clear this
        // repo's own entries too — the `.emberyx-worktrees` root is shared
        // by every test running in parallel.
        if let (Some(parent), Some(name)) = (self.0.parent(), self.0.file_name()) {
            let prefix = format!("{}-", name.to_string_lossy());
            if let Ok(entries) = std::fs::read_dir(parent.join(".emberyx-worktrees")) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(&prefix) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn status_of(files: &[GitFile], path: &str) -> String {
    files
        .iter()
        .find(|f| f.path == path)
        .unwrap_or_else(|| {
            panic!(
                "{path} not in {:?}",
                files.iter().map(|f| &f.path).collect::<Vec<_>>()
            )
        })
        .status
        .clone()
}
