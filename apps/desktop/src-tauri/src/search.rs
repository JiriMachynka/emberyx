use std::ops::ControlFlow;
use std::path::PathBuf;

use regex::RegexBuilder;
use serde::Serialize;

use crate::err;
use crate::error::Result;
use crate::files::looks_binary;
use crate::fs_walk::walk_files;

/// One matching line. `start`/`end` are byte offsets into `text` for the first
/// match on the line, so the UI can highlight it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 1-based line number.
    pub line: u32,
    pub text: String,
    pub start: u32,
    pub end: u32,
}

/// Every hit in one file, path relative to the search root.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub path: String,
    pub hits: Vec<SearchHit>,
}

/// Ceilings that keep a broad query (e.g. "e") from freezing the UI.
const MAX_FILES: usize = 500;
const MAX_HITS: usize = 2000;
const MAX_HITS_PER_FILE: usize = 50;
/// Long minified lines are useless in the results list; show a window of them.
const MAX_LINE: usize = 300;
/// Files bigger than this are skipped — they're generated, not source.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Search every text file under `path` for `query`, literal by default and as a
/// regex when `is_regex` is set. Results are capped (see the consts above); the
/// caller shows a "truncated" hint when the caps bite.
#[tauri::command]
pub async fn search_text(
    path: String,
    query: String,
    case_sensitive: bool,
    is_regex: bool,
) -> Result<Vec<SearchFile>> {
    // Reading every file in the project must not block the main thread.
    Ok(
        tauri::async_runtime::spawn_blocking(move || {
            search_blocking(path, query, case_sensitive, is_regex)
        })
        .await
        .map_err(|e| e.to_string())??,
    )
}

fn search_blocking(
    path: String,
    query: String,
    case_sensitive: bool,
    is_regex: bool,
) -> Result<Vec<SearchFile>> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(err!("not a directory: {}", path));
    }
    if query.is_empty() {
        return Ok(vec![]);
    }

    let pattern = if is_regex {
        query.clone()
    } else {
        regex::escape(&query)
    };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| err!("{}", e))?;

    let mut out: Vec<SearchFile> = vec![];
    let mut total = 0usize;

    let _ = walk_files(&root, &mut |file| {
        if out.len() >= MAX_FILES || total >= MAX_HITS {
            return ControlFlow::Break(());
        }
        let too_big = std::fs::metadata(file)
            .map(|m| m.len() > MAX_FILE_BYTES)
            .unwrap_or(true);
        if too_big {
            return ControlFlow::Continue(());
        }
        let Ok(bytes) = std::fs::read(file) else {
            return ControlFlow::Continue(());
        };
        if looks_binary(&bytes) {
            return ControlFlow::Continue(());
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            return ControlFlow::Continue(());
        };

        let mut hits = vec![];
        for (i, line) in text.lines().enumerate() {
            let Some(m) = re.find(line) else { continue };
            let (text, start, end) = clip(line, m.start(), m.end());
            hits.push(SearchHit {
                line: i as u32 + 1,
                text,
                start: start as u32,
                end: end as u32,
            });
            total += 1;
            if hits.len() >= MAX_HITS_PER_FILE || total >= MAX_HITS {
                break;
            }
        }
        if !hits.is_empty() {
            if let Ok(rel) = file.strip_prefix(&root) {
                out.push(SearchFile {
                    path: rel.to_string_lossy().to_string(),
                    hits,
                });
            }
        }
        ControlFlow::Continue(())
    });

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Trim a long line to a window around the match, returning the shown text and
/// the match offsets within it.
fn clip(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    if line.len() <= MAX_LINE {
        return (line.to_string(), start, end);
    }
    // Keep some context before the match, then cut on char boundaries.
    let from = floor_boundary(line, start.saturating_sub(40));
    let to = ceil_boundary(line, (from + MAX_LINE).min(line.len()));
    (
        line[from..to].to_string(),
        start - from,
        end.min(to) - from,
    )
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("src/a.ts"), "const Foo = 1;\nexport { Foo };\n").unwrap();
        std::fs::write(root.join("src/b.ts"), "// nothing here\n").unwrap();
        std::fs::write(root.join("node_modules/c.ts"), "const Foo = 2;\n").unwrap();
        root
    }

    #[test]
    fn finds_literal_matches_and_skips_noise_dirs() {
        let root = setup("emberyx_test_search");
        let res = search_blocking(
            root.to_string_lossy().to_string(),
            "Foo".into(),
            true,
            false,
        )
        .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].path, "src/a.ts");
        assert_eq!(res[0].hits.len(), 2);
        assert_eq!(res[0].hits[0].line, 1);
        assert_eq!(res[0].hits[0].start, 6);
        assert_eq!(res[0].hits[0].end, 9);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn case_insensitive_and_regex_modes() {
        let root = setup("emberyx_test_search_modes");
        let path = root.to_string_lossy().to_string();

        let insensitive = search_blocking(path.clone(), "foo".into(), false, false).unwrap();
        assert_eq!(insensitive.len(), 1);

        let sensitive = search_blocking(path.clone(), "foo".into(), true, false).unwrap();
        assert!(sensitive.is_empty());

        // A literal query with regex metacharacters matches nothing as a
        // literal, but the same text as a pattern does.
        let literal = search_blocking(path.clone(), "F.o".into(), true, false).unwrap();
        assert!(literal.is_empty());
        let regex = search_blocking(path, "F.o".into(), true, true).unwrap();
        assert_eq!(regex.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clips_long_lines_around_the_match() {
        let line = format!("{}NEEDLE{}", "x".repeat(500), "y".repeat(500));
        let (text, start, end) = clip(&line, 500, 506);
        assert!(text.len() <= MAX_LINE);
        assert_eq!(&text[start..end], "NEEDLE");
    }
}
