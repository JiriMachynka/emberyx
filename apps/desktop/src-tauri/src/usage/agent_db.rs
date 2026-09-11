//! OpenCode and Kilo: `$XDG_DATA_HOME/{opencode/opencode.db,kilo/kilo.db}`.
//! Both keep per-turn `tokens` + `cost` on `message.data` under the same
//! drizzle schema, so one reader covers them. (OpenCode's older JSON
//! `storage/message` tree is migrated into this database by OpenCode itself.)
//!
//! Unlike Codex, `tokens.input` excludes cache and `tokens.reasoning` is not
//! inside `tokens.output` — `tokens.total` is the sum of all five — so
//! reasoning is added to output here.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::{date_string, Rows, Totals};
use crate::models::Provider;

pub(super) fn scan(
    path: &Path,
    provider: Provider,
    cutoff_secs: u64,
    rows: &mut Rows,
    sessions: &mut HashMap<Provider, HashSet<String>>,
) {
    if !path.is_file() {
        return;
    }
    // URI so a live WAL from the agent CLI does not fail the read.
    let uri = format!("file:{}?mode=ro", path.display());
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) else {
        return;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT m.data, m.time_created, s.directory, s.id
         FROM message m
         JOIN session s ON s.id = m.session_id
         WHERE m.time_created >= ?1",
    ) else {
        return;
    };
    let cutoff_ms = i64::try_from(cutoff_secs.saturating_mul(1000)).unwrap_or(i64::MAX);
    let cutoff = date_string(cutoff_secs);
    let Ok(iter) = stmt.query_map([cutoff_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return;
    };
    for (data, time_created, directory, session_id) in iter.flatten() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some((date, project, model, totals)) =
            parse_turn(&v, time_created.max(0) as u64, &directory)
        else {
            continue;
        };
        if date.as_str() < cutoff.as_str() {
            continue;
        }
        rows.entry((date, project, model, provider))
            .or_default()
            .add(&totals);
        sessions.entry(provider).or_default().insert(session_id);
    }
}

/// One assistant turn from an OpenCode/Kilo `message.data` blob.
fn parse_turn(
    v: &serde_json::Value,
    time_created_ms: u64,
    directory: &str,
) -> Option<(String, String, String, Totals)> {
    if v["role"].as_str() != Some("assistant") {
        return None;
    }
    let tokens = &v["tokens"];
    if !tokens.is_object() {
        return None;
    }
    let cache = &tokens["cache"];
    let cost = v["cost"].as_f64();
    let totals = Totals {
        input: tokens["input"].as_u64().unwrap_or(0),
        output: tokens["output"].as_u64().unwrap_or(0) + tokens["reasoning"].as_u64().unwrap_or(0),
        cache_read: cache["read"].as_u64().unwrap_or(0),
        cache_creation: cache["write"].as_u64().unwrap_or(0),
        messages: 1,
        cost: cost.unwrap_or(0.0),
        costed: u64::from(cost.is_some()),
    };
    if totals.input == 0
        && totals.output == 0
        && totals.cache_read == 0
        && totals.cache_creation == 0
        && totals.cost == 0.0
    {
        return None;
    }
    let model = v["modelID"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| v["model"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("unknown")
        .to_string();
    let project = v["path"]["cwd"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(directory)
        .to_string();
    Some((date_string(time_created_ms / 1000), project, model, totals))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_turn(
        model: &str,
        input: u64,
        output: u64,
        reasoning: u64,
        cache_read: u64,
        cost: f64,
    ) -> serde_json::Value {
        serde_json::json!({
            "role": "assistant",
            "modelID": model,
            "cost": cost,
            "path": { "cwd": "/repo" },
            "tokens": {
                "input": input,
                "output": output,
                "reasoning": reasoning,
                "cache": { "read": cache_read, "write": 4 }
            }
        })
    }

    #[test]
    fn parses_opencode_style_assistant_turns() {
        let v = agent_turn("gpt-5.6-luna", 10, 20, 5, 100, 0.12);
        let (date, project, model, totals) =
            parse_turn(&v, 1_787_424_000_000, "/fallback").unwrap();
        assert_eq!(date, "2026-08-22");
        assert_eq!(project, "/repo");
        assert_eq!(model, "gpt-5.6-luna");
        assert_eq!(totals.input, 10);
        assert_eq!(totals.output, 25);
        assert_eq!(totals.cache_read, 100);
        assert_eq!(totals.cache_creation, 4);
        assert_eq!(totals.messages, 1);
        assert_eq!(totals.recorded_cost(), Some(0.12));
    }

    #[test]
    fn a_turn_without_a_cost_field_has_no_recorded_cost() {
        let v = serde_json::json!({
            "role": "assistant",
            "modelID": "custom-model",
            "tokens": { "input": 3, "output": 1, "cache": { "read": 0, "write": 0 } }
        });
        let (_, _, _, totals) = parse_turn(&v, 0, "/repo").unwrap();
        assert_eq!(totals.input, 3);
        assert_eq!(totals.recorded_cost(), None);
    }

    #[test]
    fn skips_user_turns_and_zero_token_errors() {
        let user = serde_json::json!({
            "role": "user",
            "tokens": { "input": 1, "output": 1, "cache": { "read": 0, "write": 0 } },
            "cost": 1.0
        });
        assert!(parse_turn(&user, 1_000, "/repo").is_none());

        let empty = serde_json::json!({
            "role": "assistant",
            "modelID": "deepseek-v4-flash",
            "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } },
            "cost": 0.0
        });
        assert!(parse_turn(&empty, 1_000, "/repo").is_none());
    }

    #[test]
    fn falls_back_to_session_directory_and_unknown_model() {
        let v = serde_json::json!({
            "role": "assistant",
            "tokens": { "input": 3, "output": 1, "cache": { "read": 0, "write": 0 } },
            "cost": 0.01
        });
        let (_, project, model, _) = parse_turn(&v, 0, "/from-session").unwrap();
        assert_eq!(project, "/from-session");
        assert_eq!(model, "unknown");
    }

    #[test]
    fn rolls_turns_into_rows_and_session_counts() {
        let path = std::env::temp_dir().join(format!(
            "emberyx-usage-agent-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (
                id text PRIMARY KEY,
                directory text NOT NULL
            );
            CREATE TABLE message (
                id text PRIMARY KEY,
                session_id text NOT NULL,
                time_created integer NOT NULL,
                data text NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, directory) VALUES ('ses_a', '/repo')",
            [],
        )
        .unwrap();
        let ts = 1_787_424_000_000i64;
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, 'ses_a', ?2, ?3)",
            rusqlite::params![
                "msg_1",
                ts,
                agent_turn("gpt-5.6-luna", 10, 2, 1, 8, 0.05).to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, 'ses_a', ?2, ?3)",
            rusqlite::params![
                "msg_2",
                ts + 1000,
                serde_json::json!({"role":"user"}).to_string()
            ],
        )
        .unwrap();
        drop(conn);

        let mut rows = HashMap::new();
        let mut sessions = HashMap::new();
        scan(
            &path,
            Provider::Opencode,
            1_787_000_000,
            &mut rows,
            &mut sessions,
        );

        let totals = rows
            .get(&(
                "2026-08-22".into(),
                "/repo".into(),
                "gpt-5.6-luna".into(),
                Provider::Opencode,
            ))
            .expect("row");
        assert_eq!(totals.input, 10);
        assert_eq!(totals.output, 3);
        assert_eq!(totals.messages, 1);
        assert_eq!(totals.recorded_cost(), Some(0.05));
        assert_eq!(sessions[&Provider::Opencode].len(), 1);

        let _ = std::fs::remove_file(&path);
    }
}
