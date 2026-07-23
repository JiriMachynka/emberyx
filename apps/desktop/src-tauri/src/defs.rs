use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::Result;
use crate::fs_walk::{extension, walk_files};

/// A candidate definition site for a symbol.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefMatch {
    /// Absolute path of the file holding the definition.
    pub path: String,
    /// 1-based line number.
    pub line: usize,
    /// The matching line, trimmed for display.
    pub text: String,
}

/// Extensions worth scanning for definitions.
const CODE_EXTS: [&str; 22] = [
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "rb", "vue", "svelte",
    "java", "kt", "swift", "c", "h", "cpp", "hpp", "php",
];

/// Keywords that introduce a named definition in the languages above. A line
/// counts as a definition when one of these is immediately followed by the
/// symbol — a deliberately simple, language-agnostic heuristic (no parsing).
const KEYWORDS: [&str; 17] = [
    "fn", "function", "const", "let", "var", "class", "interface", "type", "enum", "struct",
    "trait", "impl", "mod", "def", "macro_rules!", "static", "namespace",
];

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_MATCHES: usize = 50;

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// True if `line` defines `symbol`: a definition keyword, then the symbol as a
/// whole word. Handles prefixes like `export`, `pub`, `async`, `declare`.
fn defines(line: &str, symbol: &str) -> bool {
    let mut prev_keyword = false;
    for word in line.split_whitespace() {
        if prev_keyword {
            // Strip decorations around the name: `foo(`, `foo<T>`, `foo:`, `*foo`.
            let name: String = word
                .trim_start_matches(['*', '&', '(', '@'])
                .chars()
                .take_while(|c| is_word_char(*c))
                .collect();
            if name == symbol {
                return true;
            }
        }
        prev_keyword = KEYWORDS.contains(&word);
    }
    false
}

fn scan_file(path: &Path, symbol: &str, out: &mut Vec<DefMatch>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() > MAX_FILE_BYTES {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return; // binary or non-UTF-8
    };
    // Cheap reject before the per-line work.
    if !text.contains(symbol) {
        return;
    }
    for (i, line) in text.lines().enumerate() {
        if out.len() >= MAX_MATCHES {
            return;
        }
        if defines(line, symbol) {
            out.push(DefMatch {
                path: path.to_string_lossy().to_string(),
                line: i + 1,
                text: line.trim().chars().take(160).collect(),
            });
        }
    }
}

/// Every definition of `symbol` under `root`, capped at MAX_MATCHES.
fn scan_all(root: &Path, symbol: &str) -> Vec<DefMatch> {
    let mut out = vec![];
    let _ = walk_files(root, &mut |file| {
        if out.len() >= MAX_MATCHES {
            return ControlFlow::Break(());
        }
        if CODE_EXTS.contains(&extension(file).as_str()) {
            scan_file(file, symbol, &mut out);
        }
        ControlFlow::Continue(())
    });
    out
}

/// Find definition sites for `symbol` under `root`. Matches from the file the
/// click came from sort first, then shorter paths (closer to the root).
#[tauri::command]
pub fn find_definition(root: String, symbol: String, from: String) -> Result<Vec<DefMatch>> {
    if symbol.is_empty() || !symbol.chars().all(is_word_char) {
        return Ok(vec![]);
    }
    let mut out = scan_all(Path::new(&root), &symbol);
    out.sort_by_key(|m| (m.path != from, m.path.len()));
    Ok(out)
}

/// The definition a hover resolved to, formatted for display.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverInfo {
    pub path: String,
    pub line: usize,
    /// Doc comment + declaration, dedented and trimmed to a readable block.
    pub code: String,
    /// How many further definitions of the same symbol exist elsewhere.
    pub others: usize,
}

const MAX_SNIPPET_LINES: usize = 16;

fn is_doc_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("///")
        || t.starts_with("//!")
        || t.starts_with("/**")
        || t.starts_with("*")
        || t.starts_with("#[")
        || t.starts_with("@")
}

/// Remove the shared leading indentation from a block of lines.
fn dedent(lines: &[&str]) -> String {
    let indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|l| if l.len() >= indent { &l[indent..] } else { l.trim_start() })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Grow a declaration into a readable snippet: any doc comment directly above,
/// then the declaration itself, following its braces until they balance.
fn snippet(lines: &[&str], index: usize) -> String {
    let mut start = index;
    while start > 0 && is_doc_comment(lines[start - 1]) {
        start -= 1;
    }
    // Cap how much preamble a long doc block contributes.
    if index - start > 6 {
        start = index - 6;
    }

    let mut end = index;
    let mut depth: i32 = 0;
    let mut opened = false;
    for (offset, line) in lines[index..].iter().enumerate() {
        if offset >= MAX_SNIPPET_LINES {
            break;
        }
        for c in line.chars() {
            match c {
                '{' | '(' | '[' => {
                    depth += 1;
                    opened = true;
                }
                '}' | ')' | ']' => depth -= 1,
                _ => {}
            }
        }
        end = index + offset;
        if opened && depth <= 0 {
            break;
        }
        // A one-line declaration (`const x = 1;`) never opens a block.
        if !opened && (line.trim_end().ends_with(';') || line.trim_end().ends_with(',')) {
            break;
        }
    }
    let mut block = dedent(&lines[start..=end]);
    if end == index + MAX_SNIPPET_LINES - 1 && depth > 0 {
        block.push_str("\n…");
    }
    block
}

/// Best definition for `symbol`, formatted for a hover card.
#[tauri::command]
pub fn hover_info(root: String, symbol: String, from: String) -> Result<Option<HoverInfo>> {
    let matches = find_definition(root, symbol, from)?;
    let Some(best) = matches.first() else {
        return Ok(None);
    };
    let Ok(text) = std::fs::read_to_string(&best.path) else {
        return Ok(None);
    };
    let lines: Vec<&str> = text.lines().collect();
    if best.line == 0 || best.line > lines.len() {
        return Ok(None);
    }
    Ok(Some(HoverInfo {
        path: best.path.clone(),
        line: best.line,
        code: snippet(&lines, best.line - 1),
        others: matches.len() - 1,
    }))
}

/// Extensions tried when an import specifier has none.
const IMPORT_EXTS: [&str; 9] = ["ts", "tsx", "js", "jsx", "vue", "svelte", "mts", "d.ts", "json"];

/// Lexically clean a path: drop `.` segments and collapse `..`. Kept lexical
/// (not `canonicalize`) so paths stay comparable with the ones the file tree
/// hands out, which aren't symlink-resolved.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn resolve_file(base: &Path) -> Option<String> {
    let base = normalize(base);
    if base.is_file() {
        return Some(base.to_string_lossy().to_string());
    }
    for ext in IMPORT_EXTS {
        let candidate = PathBuf::from(format!("{}.{}", base.to_string_lossy(), ext));
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    for ext in IMPORT_EXTS {
        let candidate = base.join(format!("index.{}", ext));
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Resolve an import specifier to a file on disk. Handles relative paths and
/// the common `@/…` / `~/…` source-root aliases; returns null for packages.
#[tauri::command]
pub fn resolve_import(root: String, from: String, spec: String) -> Option<String> {
    let root = PathBuf::from(&root);
    let dir = PathBuf::from(&from).parent()?.to_path_buf();

    if spec.starts_with("./") || spec.starts_with("../") {
        return resolve_file(&dir.join(&spec));
    }
    if let Some(rest) = spec
        .strip_prefix("@/")
        .or_else(|| spec.strip_prefix("~/"))
        .or_else(|| spec.strip_prefix("#/"))
    {
        // Alias roots, in the order editors conventionally try them.
        for base in ["src", "app", "."] {
            if let Some(hit) = resolve_file(&root.join(base).join(rest)) {
                return Some(hit);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_definition_lines() {
        assert!(defines("export function fileIcon(name: string) {", "fileIcon"));
        assert!(defines("pub fn find_definition(root: String) {", "find_definition"));
        assert!(defines("const HIGHLIGHT_LIMIT = 100_000;", "HIGHLIGHT_LIMIT"));
        assert!(defines("interface EditorPaneProps {", "EditorPaneProps"));
        assert!(defines("  struct DefMatch {", "DefMatch"));
        assert!(defines("def parse_row(self):", "parse_row"));
        // Uses, not definitions.
        assert!(!defines("  const icon = fileIcon(name);", "fileIcon"));
        assert!(!defines("import { fileIcon } from \"@/lib/fileIcon\";", "fileIcon"));
        // Prefix collisions must not match.
        assert!(!defines("const fileIconMap = {};", "fileIcon"));
    }

    #[test]
    fn finds_and_ranks_definitions() {
        let root = std::env::temp_dir().join("emberyx_test_defs");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("src/a.ts"), "export const widget = 1;\n").unwrap();
        std::fs::write(root.join("src/b.ts"), "console.log(widget);\n").unwrap();
        std::fs::write(root.join("node_modules/c.ts"), "const widget = 2;\n").unwrap();

        let hits = find_definition(
            root.to_string_lossy().to_string(),
            "widget".into(),
            String::new(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("a.ts"));
        assert_eq!(hits[0].line, 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snippets_include_doc_comment_and_body() {
        let src = vec![
            "const other = 1;",
            "/** Icon + accent color for a file. */",
            "interface FileIcon {",
            "  Icon: LucideIcon;",
            "  className: string;",
            "}",
            "const after = 2;",
        ];
        let block = snippet(&src, 2);
        assert!(block.starts_with("/** Icon"));
        assert!(block.ends_with("}"));
        assert!(!block.contains("const after"));

        // A one-line declaration stops at its terminator.
        assert_eq!(snippet(&src, 0), "const other = 1;");
    }

    #[test]
    fn resolves_relative_and_aliased_imports() {
        let root = std::env::temp_dir().join("emberyx_test_imports");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::write(root.join("src/lib/utils.ts"), "").unwrap();
        std::fs::write(root.join("src/App.tsx"), "").unwrap();
        let from = root.join("src/App.tsx").to_string_lossy().to_string();
        let root_s = root.to_string_lossy().to_string();

        let rel = resolve_import(root_s.clone(), from.clone(), "./lib/utils".into()).unwrap();
        assert!(rel.ends_with("src/lib/utils.ts"));
        let alias = resolve_import(root_s.clone(), from.clone(), "@/lib/utils".into()).unwrap();
        assert!(alias.ends_with("src/lib/utils.ts"));
        assert!(resolve_import(root_s, from, "react".into()).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }
}
