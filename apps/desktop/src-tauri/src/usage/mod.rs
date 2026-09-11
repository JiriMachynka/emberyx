//! Cross-project usage dashboard: token history read back from each agent's
//! own files on disk. One reader per provider; they all land in the same
//! per-(date, project, model, provider) rows.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::error::{blocking, Result};
use crate::fs_walk::walk_files;
use crate::models::Provider;
use crate::paths::home_dir;

mod agent_db;
mod claude;
mod codex;
mod grok;

/// Every provider this module reads. The panel names the rest as uncounted,
/// so a provider whose history can't be read never reads as "spent nothing".
const COUNTED: [Provider; 5] = [
    Provider::Claude,
    Provider::Codex,
    Provider::Grok,
    Provider::Opencode,
    Provider::Kilo,
];

/// One day's usage for a single project/model pair.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// UTC date, `YYYY-MM-DD`.
    pub date: String,
    /// Which provider produced the turns.
    pub provider: Provider,
    /// Absolute project path the session ran in.
    pub project: String,
    pub model: String,
    /// Uncached input only; cache reads and writes are their own columns.
    pub input: u64,
    /// Output including reasoning.
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub messages: u64,
    /// USD the agent itself recorded (OpenCode, Kilo, Grok) — only when every
    /// turn in the row recorded one. Claude and Codex never do, so the
    /// frontend derives theirs from the rate table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Default, Clone, Copy)]
struct Totals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    messages: u64,
    cost: f64,
    /// Turns that recorded their own cost. A row whose turns didn't all
    /// record one has no known cost — a partial sum would read as the total.
    costed: u64,
}

impl Totals {
    fn add(&mut self, other: &Totals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
        self.messages += other.messages;
        self.cost += other.cost;
        self.costed += other.costed;
    }

    fn recorded_cost(&self) -> Option<f64> {
        (self.messages > 0 && self.costed == self.messages).then_some(self.cost)
    }
}

/// Distinct transcripts that contributed at least one turn in the window.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessions {
    pub provider: Provider,
    pub count: u64,
}

/// Dashboard payload: daily buckets, a session count per provider, and which
/// providers were read at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub rows: Vec<UsageRow>,
    pub sessions: Vec<ProviderSessions>,
    pub counted: Vec<Provider>,
}

/// One history file's rollup: how far it's been parsed plus its per-(date,
/// model) totals, so a re-scan only reads bytes appended since last time.
struct SummaryEntry {
    offset: u64,
    /// Modified time (secs) at the last parse — for files rewritten whole
    /// rather than appended to, where length alone can't show a change.
    modified: u64,
    project: String,
    /// Last model named in this file (Codex `turn_context`); Claude names it
    /// on every usage line instead.
    model: String,
    /// Codex's running `total_tokens` at the last counted `token_count`.
    last_total: Option<u64>,
    provider: Provider,
    buckets: HashMap<(String, String), Totals>,
}

impl Default for SummaryEntry {
    fn default() -> Self {
        Self {
            offset: 0,
            modified: 0,
            project: String::new(),
            model: String::new(),
            last_total: None,
            provider: Provider::Claude,
            buckets: HashMap::new(),
        }
    }
}

/// Per-file rollup state for the cross-project usage dashboard.
#[derive(Default)]
pub struct SummaryCache(Mutex<HashMap<String, SummaryEntry>>);

type Rows = HashMap<(String, String, String, Provider), Totals>;

/// Civil date (year, month, day) for a count of days since the unix epoch.
/// Howard Hinnant's `civil_from_days`, so no date crate is needed.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn date_string(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn modified_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Roll up token usage across every readable provider history on disk,
/// bucketed by day, project, model, and provider. Transcripts last written
/// before the window are skipped, and the rest are parsed incrementally, so
/// repeat calls are cheap.
#[tauri::command]
pub async fn usage_summary(app: tauri::AppHandle, days: u32) -> Result<UsageSummary> {
    // The first scan reads every transcript on disk; keep it off the main
    // thread so the window stays responsive while it runs.
    blocking(move || summary_blocking(&app.state::<SummaryCache>(), days)).await
}

fn summary_blocking(cache: &SummaryCache, days: u32) -> Result<UsageSummary> {
    let mut map = cache.0.lock().map_err(|e| e.to_string())?;
    let cutoff_secs = now_secs().saturating_sub(u64::from(days) * 86_400);
    Ok(summarize(
        &mut map,
        cutoff_secs,
        crate::threads::projects_dir(),
        home_dir(),
        xdg_data_home(),
    ))
}

/// The scan itself, with every root passed in so it can run against a
/// fixture tree or the real one.
fn summarize(
    map: &mut HashMap<String, SummaryEntry>,
    cutoff_secs: u64,
    claude_projects: Option<PathBuf>,
    home: Option<PathBuf>,
    data_home: Option<PathBuf>,
) -> UsageSummary {
    let cutoff = date_string(cutoff_secs);
    let mut rows: Rows = HashMap::new();
    let mut sessions: HashMap<Provider, HashSet<String>> = HashMap::new();
    // Files present on disk this pass. A cached entry whose file is gone —
    // deleted, or a Codex session moved into `archived_sessions` — must stop
    // counting, or an archived session counts once per path it ever had.
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(base) = claude_projects {
        scan_jsonl_tree(&base, cutoff_secs, map, &mut seen, claude::parse);
    }
    if let Some(home) = &home {
        let root = home.join(".codex");
        for sub in ["sessions", "archived_sessions"] {
            scan_jsonl_tree(&root.join(sub), cutoff_secs, map, &mut seen, codex::parse);
        }
        grok::scan(&home.join(".grok/sessions"), cutoff_secs, map, &mut seen);
    }
    map.retain(|path, _| seen.contains(path));

    for (path, entry) in map.iter() {
        let mut in_window = false;
        for ((date, model), totals) in &entry.buckets {
            if date.as_str() < cutoff.as_str() {
                continue;
            }
            in_window = true;
            rows.entry((
                date.clone(),
                entry.project.clone(),
                model.clone(),
                entry.provider,
            ))
            .or_default()
            .add(totals);
        }
        if in_window {
            sessions
                .entry(entry.provider)
                .or_default()
                .insert(path.clone());
        }
    }

    if let Some(data) = data_home {
        agent_db::scan(
            &data.join("opencode/opencode.db"),
            Provider::Opencode,
            cutoff_secs,
            &mut rows,
            &mut sessions,
        );
        agent_db::scan(
            &data.join("kilo/kilo.db"),
            Provider::Kilo,
            cutoff_secs,
            &mut rows,
            &mut sessions,
        );
    }

    let mut out: Vec<UsageRow> = rows
        .into_iter()
        .map(|((date, project, model, provider), t)| UsageRow {
            date,
            project,
            model,
            input: t.input,
            output: t.output,
            cache_read: t.cache_read,
            cache_creation: t.cache_creation,
            messages: t.messages,
            provider,
            cost: t.recorded_cost(),
        })
        .collect();
    out.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then(a.project.cmp(&b.project))
            .then(a.model.cmp(&b.model))
    });
    let mut session_counts: Vec<ProviderSessions> = sessions
        .into_iter()
        .map(|(provider, set)| ProviderSessions {
            provider,
            count: set.len() as u64,
        })
        .collect();
    session_counts.sort_by_key(|s| s.provider.label());
    UsageSummary {
        rows: out,
        sessions: session_counts,
        counted: COUNTED.to_vec(),
    }
}

fn scan_jsonl_tree(
    root: &Path,
    cutoff_secs: u64,
    map: &mut HashMap<String, SummaryEntry>,
    seen: &mut HashSet<String>,
    parse: fn(&str, u64, &mut SummaryEntry),
) {
    let _ = walk_files(root, &mut |path| {
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            return ControlFlow::Continue(());
        }
        let Ok(meta) = path.metadata() else {
            return ControlFlow::Continue(());
        };
        let key = path.to_string_lossy().to_string();
        seen.insert(key.clone());
        if modified_secs(&meta) < cutoff_secs && !map.contains_key(&key) {
            return ControlFlow::Continue(());
        }
        parse(&key, meta.len(), map.entry(key.clone()).or_default());
        ControlFlow::Continue(())
    });
}

/// Feed each complete line appended to `path` since the last pass to
/// `accumulate`.
fn parse_appended(
    path: &str,
    len: u64,
    entry: &mut SummaryEntry,
    accumulate: fn(&serde_json::Value, &mut SummaryEntry),
) {
    if len < entry.offset {
        let provider = entry.provider;
        *entry = SummaryEntry {
            provider,
            ..SummaryEntry::default()
        };
    }
    if len == entry.offset {
        return;
    }
    let Ok(mut file) = File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(entry.offset)).is_err() {
        return;
    }
    let mut appended = Vec::new();
    if file.read_to_end(&mut appended).is_err() {
        return;
    }
    // A read can catch a half-written final line; stop at the last newline.
    let Some(last_nl) = appended.iter().rposition(|&b| b == b'\n') else {
        return;
    };

    for line in appended[..=last_nl].split(|&b| b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        accumulate(&v, entry);
    }
    entry.offset += (last_nl + 1) as u64;
}

/// UTC day of an ISO-8601 `timestamp` field, so a session running past
/// midnight splits across the two days its turns happened on.
fn event_date(v: &serde_json::Value) -> String {
    iso_date(v["timestamp"].as_str()).unwrap_or_else(|| date_string(now_secs()))
}

fn iso_date(ts: Option<&str>) -> Option<String> {
    ts.filter(|t| t.len() >= 10 && t.is_char_boundary(10))
        .map(|t| t[..10].to_string())
}

fn xdg_data_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|home| home.join(".local/share"))
}

#[cfg(test)]
mod test_support {
    use std::path::{Path, PathBuf};

    /// A fresh scratch path under the temp dir, unique per test and process.
    pub fn temp(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("emberyx_test_usage_{}_{name}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    pub fn append(path: &Path, text: &str) -> u64 {
        use std::io::Write;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
        f.metadata().unwrap().len()
    }

    pub fn line(v: serde_json::Value) -> String {
        v.to_string() + "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn converts_epoch_days_to_civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // 2024 is a leap year: Feb 29 exists and Mar 1 follows it.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
        // 2000 is a leap year, 1900 was not — the 400/100 year rules.
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn round_trips_every_day_of_a_leap_year() {
        // Day counts must advance monotonically and stay inside valid ranges.
        let mut previous = civil_from_days(19_723);
        for day in 19_724..(19_723 + 366) {
            let current = civil_from_days(day);
            assert!(
                current > previous,
                "{current:?} did not follow {previous:?}"
            );
            assert!((1..=12).contains(&current.1));
            assert!((1..=31).contains(&current.2));
            previous = current;
        }
        assert_eq!(civil_from_days(19_723 + 366), (2025, 1, 1));
    }

    #[test]
    fn formats_dates_zero_padded() {
        assert_eq!(date_string(0), "1970-01-01");
        assert_eq!(date_string(19_723 * 86_400), "2024-01-01");
        // Any time within the day maps to the same date.
        assert_eq!(date_string(19_723 * 86_400 + 86_399), "2024-01-01");
    }

    #[test]
    fn a_row_has_a_recorded_cost_only_when_every_turn_recorded_one() {
        let costed = Totals {
            messages: 2,
            costed: 2,
            cost: 0.5,
            ..Totals::default()
        };
        assert_eq!(costed.recorded_cost(), Some(0.5));
        let partial = Totals {
            costed: 1,
            ..costed
        };
        assert_eq!(partial.recorded_cost(), None);
        // Claude and Codex never record one.
        let derived = Totals {
            messages: 3,
            ..Totals::default()
        };
        assert_eq!(derived.recorded_cost(), None);
    }

    #[test]
    fn a_moved_codex_session_counts_once() {
        let home = temp("moved_home");
        let turn = line(serde_json::json!({
            "timestamp": "2026-08-12T10:00:00Z",
            "type": "event_msg",
            "payload": { "type": "token_count", "info": {
                "total_token_usage": { "input_tokens": 10, "output_tokens": 5, "total_tokens": 15 },
                "last_token_usage": { "input_tokens": 10, "output_tokens": 5, "total_tokens": 15 }
            }}
        }));
        let live = home.join(".codex/sessions/2026/08/12/rollout-a.jsonl");
        append(&live, &turn);

        let mut map = HashMap::new();
        let first = summarize(&mut map, 0, None, Some(home.clone()), None);
        assert_eq!(first.rows.iter().map(|r| r.input).sum::<u64>(), 10);

        // `codex archive` moves the file; the old path's cache must go.
        let archived = home.join(".codex/archived_sessions/rollout-a.jsonl");
        std::fs::create_dir_all(archived.parent().unwrap()).unwrap();
        std::fs::rename(&live, &archived).unwrap();
        let second = summarize(&mut map, 0, None, Some(home.clone()), None);
        assert_eq!(second.rows.iter().map(|r| r.input).sum::<u64>(), 10);
        assert_eq!(second.sessions[0].count, 1);
        assert!(second.counted.contains(&Provider::Grok));
        assert!(!second.counted.contains(&Provider::Cursor));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// Aggregates over the real history on this machine. Never run in CI:
    /// `cargo test real_usage -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_usage_sanity() {
        let days: u64 = std::env::var("USAGE_DAYS")
            .ok()
            .and_then(|d| d.parse().ok())
            .unwrap_or(7);
        let mut map = HashMap::new();
        let started = std::time::Instant::now();
        let summary = summarize(
            &mut map,
            now_secs().saturating_sub(days * 86_400),
            crate::threads::projects_dir(),
            home_dir(),
            xdg_data_home(),
        );
        println!("scan took {:?} for the last {days} days", started.elapsed());
        let mut by: std::collections::BTreeMap<(String, String), (Totals, Option<f64>)> =
            Default::default();
        for r in &summary.rows {
            let slot = by
                .entry((r.provider.label().to_string(), r.model.clone()))
                .or_insert((Totals::default(), Some(0.0)));
            slot.0.add(&Totals {
                input: r.input,
                output: r.output,
                cache_read: r.cache_read,
                cache_creation: r.cache_creation,
                messages: r.messages,
                ..Totals::default()
            });
            slot.1 = match (slot.1, r.cost) {
                (Some(a), Some(b)) => Some(a + b),
                _ => None,
            };
        }
        for ((provider, model), (t, cost)) in by {
            println!(
                "{provider:9} {model:28} msgs={:6} in={:11} cache_r={:12} cache_w={:9} out={:9} recorded_cost={}",
                t.messages,
                t.input,
                t.cache_read,
                t.cache_creation,
                t.output,
                cost.map_or("-".to_string(), |c| format!("{c:.2}")),
            );
        }
        for s in &summary.sessions {
            println!("sessions {:9} {}", s.provider.label(), s.count);
        }
        // Compare one rollout's counted tokens with its final running total.
        if let Ok(file) = std::env::var("USAGE_CODEX_FILE") {
            let len = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            let mut entry = SummaryEntry::default();
            codex::parse(&file, len, &mut entry);
            let mut t = Totals::default();
            entry.buckets.values().for_each(|b| t.add(b));
            println!(
                "codex file: requests={} counted_total={}",
                t.messages,
                t.input + t.cache_read + t.cache_creation + t.output
            );
        }
    }
}
