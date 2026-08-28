//! Agent skills across harnesses.
//!
//! A skill is a folder with a `SKILL.md` (YAML frontmatter: `name`,
//! `description`; markdown body: the instructions). Unlike the MCP configs in
//! `mcp.rs`, the skill directories *overlap* on purpose: Claude keeps skills
//! in `~/.claude/skills`, Codex in `~/.codex/skills` and the shared
//! `~/.agents/skills`, and OpenCode, Grok and Kilo all read Claude's and the
//! shared trees as compat surfaces. One folder therefore legitimately shows
//! under several harnesses with the same path — the list reports that
//! directly rather than pretending each harness owns a private copy.
//!
//! Writes are user-scope only, and `skills_remove`/`skills_copy` accept a
//! path: it must be a direct child of one of the managed roots, so a bad
//! argument can never delete outside them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::mcp::Harness;

/// User-scope directories each harness reads skills from, in scan order.
/// The shared roots appear under several harnesses — that is the point.
fn read_dirs(harness: Harness, home: &Path) -> Vec<PathBuf> {
    let claude = home.join(".claude").join("skills");
    let agents = home.join(".agents").join("skills");
    match harness {
        Harness::Claude => vec![claude],
        Harness::Codex => vec![home.join(".codex").join("skills"), agents],
        Harness::Opencode => vec![
            home.join(".config/opencode").join("skills"),
            claude,
            agents,
        ],
        Harness::Grok => vec![home.join(".grok").join("skills"), claude, agents],
        Harness::Kilo => vec![
            home.join(".kilo").join("skills"),
            home.join(".kilocode").join("skills"),
            claude,
            agents,
        ],
    }
}

/// Where a *new* copy goes: each harness's own canonical skill home, the one
/// its docs and tooling treat as first-party.
fn write_dir(harness: Harness, home: &Path) -> PathBuf {
    match harness {
        Harness::Claude => home.join(".claude").join("skills"),
        Harness::Codex => home.join(".codex").join("skills"),
        Harness::Opencode => home.join(".config/opencode").join("skills"),
        Harness::Grok => home.join(".grok").join("skills"),
        Harness::Kilo => home.join(".kilo").join("skills"),
    }
}

/// Where this skill folder lives, if it is a direct child of a managed root.
/// Every write dir is also a read dir, so one check covers add/copy/remove.
fn managed_root_of(home: &Path, skill_dir: &Path) -> Option<PathBuf> {
    let parent = skill_dir.parent()?;
    Harness::ALL
        .into_iter()
        .flat_map(|h| read_dirs(h, home))
        .find(|root| parent == root.as_path())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// One physical skill folder and every harness that reads it. The shared
/// roots mean one folder legitimately serves several harnesses — and one
/// removal affects all of them, which the UI surfaces from this grouping.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub skill_dir: String,
    pub harnesses: Vec<Harness>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// True when copies under different roots disagree on SKILL.md content.
    pub differs: bool,
    pub sources: Vec<SkillSource>,
}

/// One discovered folder, pre-merge.
struct RawSkill {
    name: String,
    description: String,
    dir: PathBuf,
    content: String,
}

/// Collect `<dir>/<skill>/SKILL.md`. The frontmatter `name` is the identity
/// when present (OpenCode and Kilo key on it); the folder name is the
/// fallback, which is what Claude uses for the command name.
fn scan_dir(dir: &Path, out: &mut Vec<RawSkill>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_dir = entry.path();
        let file = skill_dir.join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        let folder = skill_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let named = crate::slash::frontmatter_field(&content, "name");
        let name = if named.is_empty() {
            folder.to_string()
        } else {
            named
        };
        let description = crate::slash::frontmatter_field(&content, "description");
        out.push(RawSkill {
            name,
            description,
            dir: skill_dir,
            content,
        });
    }
}

/// Scan every harness's roots and merge by skill name. Folders group their
/// readers; groups keep canonical harness order. `differs` flags names whose
/// copies under different roots disagree.
fn collect_at(home: &Path) -> Vec<SkillInfo> {
    let mut merged: BTreeMap<String, Vec<(Harness, PathBuf, String, String)>> =
        BTreeMap::new();
    for harness in Harness::ALL {
        for root in read_dirs(harness, home) {
            let mut found = Vec::new();
            scan_dir(&root, &mut found);
            for RawSkill {
                name,
                description,
                dir,
                content,
            } in found
            {
                merged
                    .entry(name)
                    .or_default()
                    .push((harness, dir, content, description));
            }
        }
    }
    merged
        .into_iter()
        .map(|(name, rows)| {
            // One group per physical folder, readers accumulated onto it.
            let mut groups: Vec<(PathBuf, String, String, Vec<Harness>)> = Vec::new();
            for (harness, dir, content, description) in rows {
                match groups.iter_mut().find(|(d, ..)| *d == dir) {
                    Some((_, _, _, readers)) => readers.push(harness),
                    None => groups.push((dir, content, description, vec![harness])),
                }
            }
            groups.sort_by_key(|(_, _, _, readers)| {
                readers
                    .iter()
                    .map(|harness| {
                        Harness::ALL
                            .iter()
                            .position(|h| h.id() == harness.id())
                            .unwrap_or(usize::MAX)
                    })
                    .min()
                    .unwrap_or(usize::MAX)
            });
            let (_, reference, description, _) = &groups[0];
            let differs = groups.iter().any(|(_, content, _, _)| content != reference);
            SkillInfo {
                name,
                description: description.clone(),
                differs,
                sources: groups
                    .into_iter()
                    .map(|(dir, _, _, mut readers)| {
                        readers.sort_by_key(|harness| {
                            Harness::ALL
                                .iter()
                                .position(|h| h.id() == harness.id())
                                .unwrap_or(usize::MAX)
                        });
                        SkillSource {
                            skill_dir: dir.display().to_string(),
                            harnesses: readers,
                        }
                    })
                    .collect(),
            }
        })
        .collect()
}

// ── Write ─────────────────────────────────────────────────────────────────

/// Quote a YAML scalar so descriptions with colons or quotes survive every
/// harness's frontmatter parser.
fn yaml_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The SKILL.md for a new skill. The folder name carries the command, so the
/// frontmatter name is written to match it (Kilo rejects a mismatch).
fn render(name: &str, description: &str, body: &str) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("name: {}\n", yaml_quote(name)));
    out.push_str(&format!("description: {}\n", yaml_quote(description)));
    out.push_str("---\n\n");
    out.push_str(body.trim_start());
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn validate_name(name: &str) -> Result<()> {
    let valid = regex::Regex::new(r"^[a-zA-Z0-9_-]+$").expect("static regex");
    if !valid.is_match(name) {
        return Err(crate::err!(
            "skill name may only contain letters, digits, - and _"
        ));
    }
    Ok(())
}

/// Create or update `<write_dir>/<name>/SKILL.md` per harness. A folder that
/// already exists keeps its other files (scripts, references) — only
/// SKILL.md is written.
fn add_at(home: &Path, spec: &SkillAddSpec) -> Result<()> {
    let file = render(&spec.name, &spec.description, &spec.body);
    for id in &spec.harnesses {
        let harness =
            Harness::from_id(id).ok_or_else(|| crate::err!("unknown harness {id}"))?;
        let dir = write_dir(harness, home).join(&spec.name);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), &file)?;
    }
    Ok(())
}

/// Copy an existing skill folder into another harness's skill home — the
/// whole folder, scripts and references included.
fn copy_at(home: &Path, skill_dir: &str, harness: Harness) -> Result<()> {
    let source = PathBuf::from(skill_dir);
    if managed_root_of(home, &source).is_none() {
        return Err(crate::err!("not a managed skill directory"));
    }
    if !source.is_dir() {
        return Err(crate::err!("no skill folder at {skill_dir}"));
    }
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| crate::err!("skill folder has no name"))?
        .to_string();
    let target = write_dir(harness, home).join(&name);
    if target == source {
        return Ok(());
    }
    if target.exists() {
        return Err(crate::err!(
            "{name} already exists in the {harness} skill folder"
        ));
    }
    copy_dir_recursive(&source, &target)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)?.flatten() {
        let kind = entry.file_type()?;
        let to = target.join(entry.file_name());
        if kind.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            // Symlinks copy as their target content — a broken link errors
            // rather than silently dropping a file the skill may need.
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Delete one skill folder. The path must come from the list — a direct child
/// of a managed root — so a stale or forged argument can't climb out.
/// `~/.claude/skills/synced` is Claude's account-synced folder and refuses.
fn remove_at(home: &Path, skill_dir: &str) -> Result<()> {
    let path = PathBuf::from(skill_dir);
    if managed_root_of(home, &path).is_none() {
        return Err(crate::err!("not a managed skill directory"));
    }
    if !path.is_dir() {
        return Err(crate::err!("no skill folder at {skill_dir}"));
    }
    if path.file_name().and_then(|n| n.to_str()) == Some("synced")
        && path.parent() == Some(home.join(".claude").join("skills").as_path())
    {
        return Err(crate::err!(
            "synced is managed by your Claude account — disable it there instead"
        ));
    }
    std::fs::remove_dir_all(&path)?;
    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAddSpec {
    /// Folder name and command; also written as the frontmatter name.
    pub name: String,
    pub description: String,
    /// Markdown instructions loaded when the skill runs.
    #[serde(default)]
    pub body: String,
    /// Harness ids from `Harness::ALL`.
    pub harnesses: Vec<String>,
}

#[tauri::command]
pub fn skills_list() -> Vec<SkillInfo> {
    match home_dir() {
        Some(home) => collect_at(&home),
        None => Vec::new(),
    }
}

#[tauri::command]
pub fn skills_add(spec: SkillAddSpec) -> Result<()> {
    validate_name(&spec.name)?;
    if spec.harnesses.is_empty() {
        return Err(crate::err!("pick at least one harness"));
    }
    let home = home_dir().ok_or_else(|| crate::err!("no home directory"))?;
    add_at(&home, &spec)
}

#[tauri::command]
pub fn skills_copy(skill_dir: String, harness: String) -> Result<()> {
    let harness =
        Harness::from_id(&harness).ok_or_else(|| crate::err!("unknown harness {harness}"))?;
    let home = home_dir().ok_or_else(|| crate::err!("no home directory"))?;
    copy_at(&home, &skill_dir, harness)
}

#[tauri::command]
pub fn skills_remove(skill_dir: String) -> Result<()> {
    let home = home_dir().ok_or_else(|| crate::err!("no home directory"))?;
    remove_at(&home, &skill_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway home with the managed roots laid out under it.
    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "emberyx-skills-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(root: &Path, folder: &str, content: &str) -> PathBuf {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
        dir
    }

    /// Frontmatter with a distinct name — the folder name alone must not
    /// decide identity when a frontmatter name is present.
    fn skill_md(name: &str, description: &str) -> String {
        format!("---\nname: {name}\ndescription: {description}\n\nSteps go here.\n")
    }

    #[test]
    fn render_survives_colons_and_quotes_and_reparses() {
        let file = render("deploy", "Runs make: deploy; then \"verify\"", "Body text.");
        assert_eq!(
            crate::slash::frontmatter_field(&file, "description"),
            "Runs make: deploy; then \"verify\""
        );
        assert_eq!(crate::slash::frontmatter_field(&file, "name"), "deploy");
        assert!(file.ends_with("Body text.\n"));
    }

    #[test]
    fn scan_reads_folders_and_skips_non_skills() {
        let home = temp_home("scan");
        let root = home.join(".claude").join("skills");
        write_skill(&root, "deploy", &skill_md("deploy", "Ship the app"));
        // No SKILL.md — not a skill folder.
        std::fs::create_dir_all(root.join("broken")).unwrap();
        // A loose file, not a folder.
        std::fs::write(root.join("loose.md"), "x").unwrap();

        let mut found = Vec::new();
        scan_dir(&root, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "deploy");
        assert_eq!(found[0].description, "Ship the app");
    }

    #[test]
    fn shared_roots_show_under_every_reader() {
        let home = temp_home("shared");
        // One folder in the shared ~/.agents tree, one in Claude's own.
        write_skill(
            &home.join(".agents").join("skills"),
            "shared-skill",
            &skill_md("shared-skill", "Shared"),
        );
        write_skill(
            &home.join(".claude").join("skills"),
            "claude-skill",
            &skill_md("claude-skill", "Claude home"),
        );

        let list = collect_at(&home);
        let by_name = |name: &str| {
            list.iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        // One physical folder in ~/.agents/skills, read by four harnesses.
        let shared = by_name("shared-skill");
        assert_eq!(shared.sources.len(), 1);
        assert_eq!(
            shared.sources[0].harnesses,
            vec![
                Harness::Codex,
                Harness::Opencode,
                Harness::Grok,
                Harness::Kilo
            ]
        );
        assert!(!shared
            .sources[0]
            .harnesses
            .contains(&Harness::Claude));

        // Claude's own home: Claude reads it first, and the compat readers
        // follow — one folder, four harnesses, still one removal.
        let claude_skill = by_name("claude-skill");
        assert_eq!(claude_skill.sources.len(), 1);
        assert_eq!(
            claude_skill.sources[0].harnesses,
            vec![
                Harness::Claude,
                Harness::Opencode,
                Harness::Grok,
                Harness::Kilo
            ]
        );
        assert!(!claude_skill.differs);
    }

    #[test]
    fn differing_copies_flag_differs() {
        let home = temp_home("differs");
        write_skill(
            &home.join(".claude").join("skills"),
            "deploy",
            &skill_md("deploy", "Ship the app"),
        );
        write_skill(
            &home.join(".codex").join("skills"),
            "deploy",
            &skill_md("deploy", "Ship the app differently"),
        );

        let list = collect_at(&home);
        let deploy = list.iter().find(|s| s.name == "deploy").unwrap();
        assert!(deploy.differs);
        // Two physical folders: Claude's home (read by four) and Codex's.
        assert_eq!(deploy.sources.len(), 2);
        assert_eq!(deploy.sources[0].harnesses.len(), 4);
        assert_eq!(deploy.sources[1].harnesses, vec![Harness::Codex]);
    }

    #[test]
    fn add_writes_each_harness_home_and_list_sees_it() {
        let home = temp_home("add");
        let spec = SkillAddSpec {
            name: "review".into(),
            description: "Review a diff".into(),
            body: "Read the diff first.".into(),
            harnesses: vec!["claude".into(), "kilo".into()],
        };
        add_at(&home, &spec).unwrap();

        let claude_file = home
            .join(".claude")
            .join("skills")
            .join("review")
            .join("SKILL.md");
        let kilo_file = home.join(".kilo").join("skills").join("review").join("SKILL.md");
        assert!(claude_file.is_file());
        assert!(kilo_file.is_file());

        let list = collect_at(&home);
        let review = list.iter().find(|s| s.name == "review").unwrap();
        // Claude's home copy is read by four harnesses; Kilo's own only by it.
        assert_eq!(review.sources.len(), 2);
        assert_eq!(review.sources[1].harnesses, vec![Harness::Kilo]);
        assert_eq!(review.description, "Review a diff");
    }

    #[test]
    fn add_overwrites_skill_md_but_keeps_sibling_files() {
        let home = temp_home("overwrite");
        let spec = SkillAddSpec {
            name: "deploy".into(),
            description: "First".into(),
            body: "v1".into(),
            harnesses: vec!["claude".into()],
        };
        add_at(&home, &spec).unwrap();
        // A script the skill ships with — a later add must not wipe it.
        let scripts = home.join(".claude").join("skills").join("deploy");
        std::fs::write(scripts.join("run.sh"), "#!/bin/sh").unwrap();

        add_at(
            &home,
            &SkillAddSpec {
                name: "deploy".into(),
                description: "Second".into(),
                body: "v2".into(),
                harnesses: vec!["claude".into()],
            },
        )
        .unwrap();

        let file = std::fs::read_to_string(scripts.join("SKILL.md")).unwrap();
        assert!(file.contains("Second"));
        assert!(scripts.join("run.sh").is_file());
    }

    #[test]
    fn copy_clones_the_whole_folder_into_the_target_home() {
        let home = temp_home("copy");
        let source = write_skill(
            &home.join(".claude").join("skills"),
            "deploy",
            &skill_md("deploy", "Ship the app"),
        );
        std::fs::create_dir_all(source.join("scripts")).unwrap();
        std::fs::write(source.join("scripts").join("run.sh"), "#!/bin/sh").unwrap();

        copy_at(&home, &source.display().to_string(), Harness::Codex).unwrap();
        let target = home.join(".codex").join("skills").join("deploy");
        assert!(target.join("SKILL.md").is_file());
        assert!(target.join("scripts").join("run.sh").is_file());

        // Copying again conflicts instead of clobbering.
        assert!(copy_at(&home, &source.display().to_string(), Harness::Codex).is_err());
        // Same folder is a no-op.
        assert!(copy_at(&home, &target.display().to_string(), Harness::Codex).is_ok());
    }

    #[test]
    fn remove_deletes_only_valid_managed_folders() {
        let home = temp_home("remove");
        let skill = write_skill(
            &home.join(".claude").join("skills"),
            "deploy",
            &skill_md("deploy", "Ship the app"),
        );

        // Outside any managed root.
        let outside = home.join("elsewhere").join("deploy");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(remove_at(&home, &outside.display().to_string()).is_err());
        // A nested path inside a root, not a direct child.
        assert!(remove_at(&home, &skill.join("SKILL.md").display().to_string()).is_err());

        remove_at(&home, &skill.display().to_string()).unwrap();
        assert!(!skill.exists());

        // Claude's account-synced folder refuses.
        let synced = write_skill(
            &home.join(".claude").join("skills"),
            "synced",
            &skill_md("synced", "Managed by Claude account sync"),
        );
        assert!(remove_at(&home, &synced.display().to_string()).is_err());
        assert!(synced.exists());
    }

    #[test]
    fn skill_names_are_restricted() {
        assert!(validate_name("deploy-staging_2").is_ok());
        assert!(validate_name("has space").is_err());
        assert!(validate_name("").is_err());
    }
}
