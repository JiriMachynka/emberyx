use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;

/// A slash command the chat composer can offer, as Claude Code resolves them:
/// project commands, personal commands, and commands/skills from installed
/// plugins (which are namespaced `plugin:name`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Invocation without the leading slash, e.g. "review" or "caveman:compress".
    pub name: String,
    pub description: String,
    /// Where it came from: "project", "user", or the plugin's name.
    pub source: String,
}

/// Pull `description:` out of a markdown file's YAML frontmatter. Returns an
/// empty string when there's no frontmatter or no description key.
fn frontmatter_description(text: &str) -> String {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            return rest.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    String::new()
}

/// Collect `*.md` command files under `dir`. Files in subdirectories become
/// namespaced commands (`dir/name.md` → `dir:name`), matching Claude Code.
fn collect_commands(dir: &Path, source: &str, prefix: &str, out: &mut Vec<SlashCommand>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            collect_commands(&path, source, &format!("{prefix}{name}:"), out);
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

/// Every slash command available in `cwd`, project first, then personal, then
/// plugin-provided ones.
#[tauri::command]
pub async fn slash_commands(cwd: String) -> Result<Vec<SlashCommand>> {
    Ok(tauri::async_runtime::spawn_blocking(move || scan(&cwd))
        .await
        .map_err(|e| e.to_string())?)
}

fn scan(cwd: &str) -> Vec<SlashCommand> {
    let mut out = vec![];
    let project = Path::new(cwd).join(".claude");
    collect_commands(&project.join("commands"), "project", "", &mut out);
    collect_skills(&project.join("skills"), "project", "", &mut out);

    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        let user = home.join(".claude");
        collect_commands(&user.join("commands"), "user", "", &mut out);
        collect_skills(&user.join("skills"), "user", "", &mut out);

        // Plugin commands and skills are invoked namespaced: `/plugin:name`.
        for (plugin, path) in installed_plugins(&home) {
            let prefix = format!("{plugin}:");
            collect_commands(&path.join("commands"), &plugin, &prefix, &mut out);
            collect_skills(&path.join("skills"), &plugin, &prefix, &mut out);
        }
    }

    // Same name from two sources: the earlier (more specific) one wins.
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.name.clone()));
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

        let found = scan(&root.to_string_lossy());
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
}
