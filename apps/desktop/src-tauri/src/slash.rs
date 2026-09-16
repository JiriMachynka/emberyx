use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;
use crate::mcp::Harness;
use crate::paths::home_dir;
use crate::skills::skill_dirs;

/// A slash command the chat composer can offer. Claude, OpenCode, Grok and
/// Kilo resolve these from skill/command folders; Codex lists its skills over
/// the app-server instead. Plugin commands are namespaced `plugin:name`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Invocation without the leading slash, e.g. "review" or "caveman:compress".
    pub name: String,
    pub description: String,
    /// Where it came from: "project", "user", or the plugin's name.
    pub source: String,
}

/// Pull one `key:` out of a markdown file's YAML frontmatter. Returns an
/// empty string when there's no frontmatter or no such key. Double-quoted
/// values are unescaped; single-quoted ones lose their outer quotes.
pub(crate) fn frontmatter_field(text: &str, field: &str) -> String {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some(rest) = trimmed
            .strip_prefix(field)
            .and_then(|r| r.strip_prefix(':'))
        else {
            continue;
        };
        let value = rest.trim();
        if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            return unescape_double(&value[1..value.len() - 1]);
        }
        return value.trim_matches('\'').to_string();
    }
    String::new()
}

/// Unescape a double-quoted YAML scalar, character-wise so `\\n` stays a
/// literal backslash-n while `\n` becomes a newline.
fn unescape_double(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('n') => out.push('\n'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Pull `description:` out of a markdown file's YAML frontmatter.
fn frontmatter_description(text: &str) -> String {
    frontmatter_field(text, "description")
}

/// Collect `*.md` command files under `dir`. Nested files become namespaced
/// commands (`dir/name.md` → `dir{sep}name`). Claude and Grok use `:`;
/// OpenCode uses `/`.
fn collect_commands(
    dir: &Path,
    source: &str,
    prefix: &str,
    sep: &str,
    out: &mut Vec<SlashCommand>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            collect_commands(&path, source, &format!("{prefix}{name}{sep}"), sep, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        out.push(SlashCommand {
            name: format!("{prefix}{stem}"),
            description: frontmatter_description(&text),
            source: source.to_string(),
        });
    }
}

/// Collect `<dir>/<skill>/SKILL.md` skills, which are invoked like commands.
fn collect_skills(dir: &Path, source: &str, prefix: &str, out: &mut Vec<SlashCommand>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file = entry.path().join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        out.push(SlashCommand {
            name: format!("{prefix}{name}"),
            description: frontmatter_description(&text),
            source: source.to_string(),
        });
    }
}

/// Install paths of every installed plugin, keyed by plugin name (the part of
/// `name@marketplace` before the `@`).
fn installed_plugins(home: &Path) -> Vec<(String, PathBuf)> {
    let file = home.join(".claude/plugins/installed_plugins.json");
    let Ok(text) = std::fs::read_to_string(file) else {
        return vec![];
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    let Some(plugins) = json["plugins"].as_object() else {
        return vec![];
    };
    plugins
        .iter()
        .filter_map(|(key, installs)| {
            let name = key.split('@').next()?.to_string();
            // Newest install last; the array is append-ordered per version.
            let path = installs
                .as_array()?
                .last()?
                .get("installPath")?
                .as_str()?
                .to_string();
            Some((name, PathBuf::from(path)))
        })
        .collect()
}

/// Every slash command available in `cwd` for `backend`. `backend` omitted
/// or unknown falls back to Claude's trees — the original scan. Codex's live
/// listing goes through the app-server; this file scan is only a fallback.
#[tauri::command]
pub async fn slash_commands(cwd: String, backend: Option<String>) -> Result<Vec<SlashCommand>> {
    Ok(tauri::async_runtime::spawn_blocking(move || scan(&cwd, backend.as_deref()))
        .await
        .map_err(|e| e.to_string())?)
}

fn scan(cwd: &str, backend: Option<&str>) -> Vec<SlashCommand> {
    scan_at(Path::new(cwd), backend, home_dir().as_deref())
}

fn scan_at(cwd: &Path, backend: Option<&str>, home: Option<&Path>) -> Vec<SlashCommand> {
    let harness = backend.and_then(Harness::from_id).unwrap_or(Harness::Claude);
    match harness {
        Harness::Claude => scan_claude(cwd, home),
        other => scan_harness(other, cwd, home),
    }
}

/// Same name from two sources: the earlier (more specific) one wins.
fn dedup(mut out: Vec<SlashCommand>) -> Vec<SlashCommand> {
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.name.clone()));
    out
}

fn scan_claude(cwd: &Path, home: Option<&Path>) -> Vec<SlashCommand> {
    let mut out = vec![];
    collect_commands(
        &cwd.join(".claude").join("commands"),
        "project",
        "",
        ":",
        &mut out,
    );
    for (dir, source) in skill_dirs(Harness::Claude, home, cwd) {
        collect_skills(&dir, source, "", &mut out);
    }
    if let Some(home) = home {
        collect_commands(
            &home.join(".claude").join("commands"),
            "user",
            "",
            ":",
            &mut out,
        );
        // Plugin commands and skills are invoked namespaced: `/plugin:name`.
        for (plugin, path) in installed_plugins(home) {
            let prefix = format!("{plugin}:");
            collect_commands(&path.join("commands"), &plugin, &prefix, ":", &mut out);
            collect_skills(&path.join("skills"), &plugin, &prefix, &mut out);
        }
    }
    dedup(out)
}

/// Skills (and, where the CLI has them, command files) for a non-Claude
/// harness. Project trees first, then the user homes `skills.rs` already
/// documents as overlapping on purpose.
fn scan_harness(harness: Harness, cwd: &Path, home: Option<&Path>) -> Vec<SlashCommand> {
    let mut out = vec![];
    for (dir, source) in skill_dirs(harness, home, cwd) {
        collect_skills(&dir, source, "", &mut out);
    }
    for (dir, source, sep) in command_dirs(harness, cwd, home) {
        collect_commands(&dir, source, "", sep, &mut out);
    }
    dedup(out)
}

/// Command-file trees, matching each CLI's own layout. Skills live in
/// `skill_dirs`; this is only the `commands/` markdown the `/` menu also
/// offers. Codex has no file-scan command tree here — its listing is the
/// app-server.
fn command_dirs(
    harness: Harness,
    cwd: &Path,
    home: Option<&Path>,
) -> Vec<(PathBuf, &'static str, &'static str)> {
    let mut out = Vec::new();
    match harness {
        Harness::Claude | Harness::Codex => {}
        Harness::Opencode => {
            out.push((cwd.join(".opencode").join("commands"), "project", "/"));
            if let Some(home) = home {
                out.push((
                    home.join(".config/opencode").join("commands"),
                    "user",
                    "/",
                ));
            }
        }
        Harness::Grok => {
            for (dir, source) in [
                (cwd.join(".grok").join("commands"), "project"),
                (cwd.join(".claude").join("commands"), "project"),
                (cwd.join(".agents").join("commands"), "project"),
            ] {
                out.push((dir, source, ":"));
            }
            if let Some(home) = home {
                for dir in [
                    home.join(".grok").join("commands"),
                    home.join(".claude").join("commands"),
                    home.join(".agents").join("commands"),
                ] {
                    out.push((dir, "user", ":"));
                }
            }
        }
        Harness::Kilo => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_description_from_frontmatter() {
        let md = "---\ndescription: Do the thing\nargument-hint: [x]\n---\n\n# Body\n";
        assert_eq!(frontmatter_description(md), "Do the thing");
        assert_eq!(frontmatter_description("# No frontmatter\n"), "");
    }

    #[test]
    fn reads_installed_plugin_paths() {
        let root = std::env::temp_dir().join("emberyx_test_slash_plugins");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".claude/plugins")).unwrap();
        std::fs::write(
            root.join(".claude/plugins/installed_plugins.json"),
            r#"{"plugins":{"caveman@caveman":[{"installPath":"/tmp/caveman"}]}}"#,
        )
        .unwrap();

        let found = installed_plugins(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "caveman");
        assert_eq!(found[0].1, PathBuf::from("/tmp/caveman"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collects_project_commands_and_namespaces_subdirs() {
        let root = std::env::temp_dir().join("emberyx_test_slash");
        let _ = std::fs::remove_dir_all(&root);
        let commands = root.join(".claude/commands");
        std::fs::create_dir_all(commands.join("git")).unwrap();
        std::fs::write(
            commands.join("review.md"),
            "---\ndescription: Review the diff\n---\n",
        )
        .unwrap();
        std::fs::write(commands.join("git/sync.md"), "no frontmatter").unwrap();

        let found = scan(&root.to_string_lossy(), None);
        let mut names: Vec<&str> = found
            .iter()
            .filter(|c| c.source == "project")
            .map(|c| c.name.as_str())
            .collect();
        names.sort();
        assert_eq!(names, vec!["git:sync", "review"]);

        let review = found.iter().find(|c| c.name == "review").unwrap();
        assert_eq!(review.description, "Review the diff");

        let _ = std::fs::remove_dir_all(&root);
    }

    fn write_skill(root: &Path, folder: &str, name: &str, description: &str) {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nBody.\n"),
        )
        .unwrap();
    }

    #[test]
    fn opencode_lists_project_and_user_skills_and_slash_commands() {
        let home = std::env::temp_dir().join(format!(
            "emberyx-slash-opencode-{}-{}",
            std::process::id(),
            "home"
        ));
        let cwd = std::env::temp_dir().join(format!(
            "emberyx-slash-opencode-{}-{}",
            std::process::id(),
            "cwd"
        ));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);

        write_skill(
            &cwd.join(".opencode").join("skills"),
            "ship",
            "ship",
            "Ship from the repo",
        );
        write_skill(
            &home.join(".config/opencode").join("skills"),
            "review",
            "review",
            "Review from user home",
        );
        let commands = cwd.join(".opencode").join("commands");
        std::fs::create_dir_all(commands.join("team")).unwrap();
        std::fs::write(commands.join("team").join("sync.md"), "---\ndescription: Sync\n---\n")
            .unwrap();

        let found = scan_at(&cwd, Some("opencode"), Some(&home));
        let names: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"ship"));
        assert!(names.contains(&"review"));
        assert!(names.contains(&"team/sync"));
        assert_eq!(
            found.iter().find(|c| c.name == "ship").unwrap().source,
            "project"
        );

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn grok_and_kilo_read_their_own_trees() {
        let home = std::env::temp_dir().join(format!(
            "emberyx-slash-gk-{}-{}",
            std::process::id(),
            "home"
        ));
        let cwd = std::env::temp_dir().join(format!(
            "emberyx-slash-gk-{}-{}",
            std::process::id(),
            "cwd"
        ));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);

        write_skill(&cwd.join(".grok").join("skills"), "commit", "commit", "Grok commit");
        write_skill(&home.join(".kilo").join("skills"), "deploy", "deploy", "Kilo deploy");

        let grok = scan_at(&cwd, Some("grok"), Some(&home));
        assert!(grok.iter().any(|c| c.name == "commit"));
        assert!(!grok.iter().any(|c| c.name == "deploy"));

        let kilo = scan_at(&cwd, Some("kilo"), Some(&home));
        assert!(kilo.iter().any(|c| c.name == "deploy"));
        assert!(!kilo.iter().any(|c| c.name == "commit"));

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn project_skill_wins_over_the_user_copy() {
        let home = std::env::temp_dir().join(format!(
            "emberyx-slash-dedup-{}-{}",
            std::process::id(),
            "home"
        ));
        let cwd = std::env::temp_dir().join(format!(
            "emberyx-slash-dedup-{}-{}",
            std::process::id(),
            "cwd"
        ));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);

        write_skill(
            &cwd.join(".grok").join("skills"),
            "commit",
            "commit",
            "Project",
        );
        write_skill(
            &home.join(".grok").join("skills"),
            "commit",
            "commit",
            "User",
        );

        let found = scan_at(&cwd, Some("grok"), Some(&home));
        let commit = found.iter().find(|c| c.name == "commit").unwrap();
        assert_eq!(commit.source, "project");
        assert_eq!(commit.description, "Project");

        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
