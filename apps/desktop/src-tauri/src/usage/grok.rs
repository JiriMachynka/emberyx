//! Grok CLI: `~/.grok/sessions/<percent-encoded cwd>/<session>/usage.json`.
//!
//! Rewritten whole after every turn (not appended), with per-turn,
//! per-model counters and the API's own `costUsdTicks`. Only sessions from a
//! Grok new enough to write the file are counted; older ones kept no tokens.
//!
//! Counters follow OpenAI's convention — `totalTokens = input + output`,
//! cached input inside `inputTokens`, reasoning inside `outputTokens`.

use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::path::Path;

use super::{iso_date, modified_secs, SummaryEntry, Totals};
use crate::fs_walk::walk_files;
use crate::models::Provider;

/// xAI prices in ticks: 1 USD = 10^10 ticks.
const TICKS_PER_USD: f64 = 1e10;

pub(super) fn scan(
    root: &Path,
    cutoff_secs: u64,
    map: &mut HashMap<String, SummaryEntry>,
    seen: &mut HashSet<String>,
) {
    let _ = walk_files(root, &mut |path| {
        if path.file_name().and_then(|n| n.to_str()) != Some("usage.json") {
            return ControlFlow::Continue(());
        }
        let Ok(meta) = path.metadata() else {
            return ControlFlow::Continue(());
        };
        let key = path.to_string_lossy().to_string();
        seen.insert(key.clone());
        let modified = modified_secs(&meta);
        if let Some(entry) = map.get(&key) {
            if entry.offset == meta.len() && entry.modified == modified {
                return ControlFlow::Continue(());
            }
        } else if modified < cutoff_secs {
            return ControlFlow::Continue(());
        }
        let Some(entry) = read(path, meta.len(), modified) else {
            return ControlFlow::Continue(());
        };
        map.insert(key, entry);
        ControlFlow::Continue(())
    });
}

fn read(path: &Path, len: u64, modified: u64) -> Option<SummaryEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    // Caught mid-rewrite: keep whatever the last good read produced.
    let v = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let project = path
        .parent()
        .and_then(Path::parent)
        .and_then(|dir| dir.file_name())
        .and_then(|n| n.to_str())
        .map(percent_decode)
        .unwrap_or_default();
    let mut entry = SummaryEntry {
        offset: len,
        modified,
        project,
        provider: Provider::Grok,
        ..SummaryEntry::default()
    };
    accumulate(&v, &mut entry);
    Some(entry)
}

fn accumulate(v: &serde_json::Value, entry: &mut SummaryEntry) {
    let primary = v["session"]["primaryModelId"]
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or("unknown");
    let Some(turns) = v["turns"].as_array() else {
        return;
    };
    for turn in turns {
        let Some(date) = iso_date(turn["endedAt"].as_str()) else {
            continue;
        };
        match turn["modelUsage"].as_object().filter(|m| !m.is_empty()) {
            Some(models) => {
                for (model, usage) in models {
                    add(entry, &date, model, usage);
                }
            }
            None => add(entry, &date, primary, turn),
        }
    }
}

fn add(entry: &mut SummaryEntry, date: &str, model: &str, usage: &serde_json::Value) {
    let input = usage["inputTokens"].as_u64().unwrap_or(0);
    let cached = usage["cachedReadTokens"].as_u64().unwrap_or(0);
    let written = usage["cacheCreationTokens"].as_u64().unwrap_or(0);
    let output = usage["outputTokens"].as_u64().unwrap_or(0);
    if input == 0 && output == 0 {
        return;
    }
    let calls = usage["modelCalls"].as_u64().unwrap_or(0).max(1);
    let ticks = usage["costUsdTicks"].as_f64();
    entry
        .buckets
        .entry((date.to_string(), model.to_string()))
        .or_default()
        .add(&Totals {
            input: input.saturating_sub(cached + written),
            output,
            cache_read: cached,
            cache_creation: written,
            messages: calls,
            cost: ticks.map_or(0.0, |t| t / TICKS_PER_USD),
            costed: if ticks.is_some() { calls } else { 0 },
        });
}

/// `%2FUsers%2Fme%2Frepo` → `/Users/me/repo`: Grok names each project
/// directory after its cwd, percent-encoded.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::temp;
    use super::*;

    fn usage_json(turns: serde_json::Value) -> String {
        serde_json::json!({
            "sessionId": "s",
            "session": { "primaryModelId": "grok-4.6-build" },
            "turns": turns,
        })
        .to_string()
    }

    fn turn(
        ended: &str,
        model: &str,
        input: u64,
        cached: u64,
        output: u64,
        ticks: u64,
    ) -> serde_json::Value {
        let usage = serde_json::json!({
            "inputTokens": input,
            "cachedReadTokens": cached,
            "cacheCreationTokens": 0,
            "outputTokens": output,
            "reasoningTokens": output / 2,
            "totalTokens": input + output,
            "modelCalls": 1,
            "costUsdTicks": ticks,
        });
        let mut t = usage.clone();
        t["endedAt"] = ended.into();
        t["modelUsage"] = serde_json::json!({ model: usage });
        t
    }

    fn write(root: &Path, text: &str) -> std::path::PathBuf {
        let path = root.join("%2Frepo%20a/session-1/usage.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn reads_per_turn_usage_with_the_recorded_cost() {
        let root = temp("grok_sessions");
        write(
            &root,
            &usage_json(serde_json::json!([
                turn(
                    "2026-09-09T23:59:00+00:00",
                    "grok-4.6-build",
                    1000,
                    800,
                    50,
                    5_000_000_000
                ),
                turn(
                    "2026-09-10T00:01:00+00:00",
                    "grok-4.6-build",
                    2000,
                    1500,
                    70,
                    10_000_000_000u64
                ),
            ])),
        );

        let mut map = HashMap::new();
        let mut seen = HashSet::new();
        scan(&root, 0, &mut map, &mut seen);
        let entry = map.values().next().unwrap();
        assert_eq!(entry.provider, Provider::Grok);
        assert_eq!(entry.project, "/repo a");
        // Each turn lands on the day it ended.
        let first = &entry.buckets[&("2026-09-09".into(), "grok-4.6-build".into())];
        assert_eq!(
            (first.input, first.cache_read, first.output),
            (200, 800, 50)
        );
        assert_eq!(first.recorded_cost(), Some(0.5));
        let second = &entry.buckets[&("2026-09-10".into(), "grok-4.6-build".into())];
        assert_eq!(second.recorded_cost(), Some(1.0));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rewrite_replaces_the_session_instead_of_adding_to_it() {
        let root = temp("grok_rewrite");
        let one = turn("2026-09-09T10:00:00+00:00", "grok-4.6-build", 100, 0, 10, 0);
        let path = write(&root, &usage_json(serde_json::json!([one.clone()])));

        let mut map = HashMap::new();
        scan(&root, 0, &mut map, &mut HashSet::new());
        // The next turn rewrites the file with both turns in it.
        let two = turn("2026-09-09T11:00:00+00:00", "grok-4.6-build", 300, 0, 30, 0);
        std::fs::write(&path, usage_json(serde_json::json!([one, two]))).unwrap();
        scan(&root, 0, &mut map, &mut HashSet::new());

        let bucket =
            &map.values().next().unwrap().buckets[&("2026-09-09".into(), "grok-4.6-build".into())];
        assert_eq!((bucket.input, bucket.messages), (400, 2));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_caught_mid_rewrite_keeps_the_last_good_read() {
        let root = temp("grok_partial");
        let good = usage_json(serde_json::json!([turn(
            "2026-09-09T10:00:00+00:00",
            "grok-4.6-build",
            100,
            0,
            10,
            0
        )]));
        let path = write(&root, &good);

        let mut map = HashMap::new();
        scan(&root, 0, &mut map, &mut HashSet::new());
        std::fs::write(&path, &good[..good.len() / 2]).unwrap();
        scan(&root, 0, &mut map, &mut HashSet::new());

        let entry = map.values().next().unwrap();
        assert_eq!(entry.buckets.values().map(|t| t.input).sum::<u64>(), 100);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_turn_without_model_usage_falls_back_to_the_primary_model() {
        let mut entry = SummaryEntry::default();
        accumulate(
            &serde_json::json!({
                "session": { "primaryModelId": "grok-4.6-build" },
                "turns": [{ "endedAt": "2026-09-09T10:00:00Z", "inputTokens": 5, "outputTokens": 1 }]
            }),
            &mut entry,
        );
        let bucket = &entry.buckets[&("2026-09-09".into(), "grok-4.6-build".into())];
        assert_eq!(bucket.input, 5);
        // No ticks recorded: the cost is unknown, not zero.
        assert_eq!(bucket.recorded_cost(), None);
    }

    #[test]
    fn decodes_percent_encoded_project_dirs() {
        assert_eq!(
            percent_decode("%2FUsers%2Fme%2Fmy%20repo"),
            "/Users/me/my repo"
        );
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
