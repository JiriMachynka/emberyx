//! Claude Code transcripts: `~/.claude/projects/**/*.jsonl`, one `usage`
//! object per assistant line.

use super::{event_date, parse_appended, SummaryEntry};
use crate::models::Provider;

/// Parse the bytes appended to one transcript since the last pass into `entry`.
pub(super) fn parse(path: &str, len: u64, entry: &mut SummaryEntry) {
    entry.provider = Provider::Claude;
    parse_appended(path, len, entry, accumulate);
}

fn accumulate(v: &serde_json::Value, entry: &mut SummaryEntry) {
    if entry.project.is_empty() {
        if let Some(cwd) = v["cwd"].as_str() {
            entry.project = cwd.to_string();
        }
    }
    let msg = &v["message"];
    let usage = &msg["usage"];
    if !usage.is_object() {
        return;
    }
    let date = event_date(v);
    let model = msg["model"].as_str().unwrap_or("unknown").to_string();
    let bucket = entry.buckets.entry((date, model)).or_default();
    bucket.input += usage["input_tokens"].as_u64().unwrap_or(0);
    bucket.output += usage["output_tokens"].as_u64().unwrap_or(0);
    bucket.cache_read += usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    bucket.cache_creation += usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    bucket.messages += 1;
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{append, temp};
    use super::*;

    /// One assistant turn as Claude Code writes it to a transcript.
    fn turn(timestamp: &str, model: &str, input: u64, output: u64) -> String {
        serde_json::json!({
            "cwd": "/repo",
            "timestamp": timestamp,
            "message": {
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_read_input_tokens": 1,
                    "cache_creation_input_tokens": 2,
                }
            }
        })
        .to_string()
            + "\n"
    }

    #[test]
    fn sums_usage_into_per_day_per_model_buckets() {
        let path = temp("buckets.jsonl");
        let len = append(
            &path,
            &(turn("2026-07-01T10:00:00Z", "claude-opus-4-8", 10, 5)
                + &turn("2026-07-01T11:00:00Z", "claude-opus-4-8", 1, 2)
                + &turn("2026-07-02T10:00:00Z", "claude-sonnet-4-5", 100, 50)),
        );

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);

        assert_eq!(entry.project, "/repo");
        // Two days, and the first day's two turns share one (date, model) key.
        assert_eq!(entry.buckets.len(), 2);

        let day_one = &entry.buckets[&("2026-07-01".into(), "claude-opus-4-8".into())];
        assert_eq!((day_one.input, day_one.output), (11, 7));
        assert_eq!(day_one.messages, 2);
        assert_eq!((day_one.cache_read, day_one.cache_creation), (2, 4));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parses_only_the_bytes_appended_since_the_last_pass() {
        let path = temp("incremental.jsonl");
        let mut entry = SummaryEntry::default();

        let len = append(&path, &turn("2026-07-01T10:00:00Z", "opus", 10, 5));
        parse(path.to_str().unwrap(), len, &mut entry);
        let after_first = entry.offset;
        assert_eq!(after_first, len);

        let len = append(&path, &turn("2026-07-01T11:00:00Z", "opus", 3, 1));
        parse(path.to_str().unwrap(), len, &mut entry);

        let bucket = &entry.buckets[&("2026-07-01".into(), "opus".into())];
        assert_eq!((bucket.input, bucket.output, bucket.messages), (13, 6, 2));
        assert_eq!(entry.offset, len);

        // A pass with nothing appended must not double-count.
        parse(path.to_str().unwrap(), len, &mut entry);
        let bucket = &entry.buckets[&("2026-07-01".into(), "opus".into())];
        assert_eq!(bucket.messages, 2);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn leaves_a_half_written_final_line_for_the_next_pass() {
        let path = temp("partial.jsonl");
        let mut entry = SummaryEntry::default();

        let complete = turn("2026-07-01T10:00:00Z", "opus", 10, 5);
        let len = append(&path, &format!("{complete}{{\"partial\": tru"));
        parse(path.to_str().unwrap(), len, &mut entry);

        assert_eq!(
            entry.buckets[&("2026-07-01".into(), "opus".into())].messages,
            1
        );
        assert_eq!(entry.offset, complete.len() as u64);

        // Once the line is finished, the next pass picks it up whole.
        append(&path, "e}\n");
        let len = append(&path, &turn("2026-07-01T12:00:00Z", "opus", 1, 1));
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(
            entry.buckets[&("2026-07-01".into(), "opus".into())].messages,
            2
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn restarts_when_the_transcript_shrinks() {
        let path = temp("truncated.jsonl");
        let mut entry = SummaryEntry::default();

        let len = append(
            &path,
            &turn("2026-07-01T10:00:00Z", "opus", 10, 5).repeat(3),
        );
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(
            entry.buckets[&("2026-07-01".into(), "opus".into())].messages,
            3
        );

        // A different session resumed at this path and rewrote it shorter.
        let _ = std::fs::remove_file(&path);
        let len = append(&path, &turn("2026-07-05T10:00:00Z", "opus", 1, 1));
        parse(path.to_str().unwrap(), len, &mut entry);

        assert!(!entry
            .buckets
            .contains_key(&("2026-07-01".into(), "opus".into())));
        assert_eq!(
            entry.buckets[&("2026-07-05".into(), "opus".into())].messages,
            1
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn skips_lines_that_carry_no_usage() {
        let path = temp("no_usage.jsonl");
        let len = append(
            &path,
            &format!(
                "not json\n\n{}{}{}",
                r#"{"type":"summary"}"#.to_string() + "\n",
                r#"{"message":{"model":"opus","usage":"not an object"}}"#.to_string() + "\n",
                turn("2026-07-01T10:00:00Z", "opus", 7, 3)
            ),
        );

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);

        assert_eq!(entry.buckets.len(), 1);
        assert_eq!(
            entry.buckets[&("2026-07-01".into(), "opus".into())].input,
            7
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn defaults_the_model_when_a_turn_does_not_name_one() {
        let path = temp("unknown_model.jsonl");
        let len = append(
            &path,
            &(serde_json::json!({
                "timestamp": "2026-07-01T10:00:00Z",
                "message": { "usage": { "input_tokens": 5 } }
            })
            .to_string()
                + "\n"),
        );

        let mut entry = SummaryEntry::default();
        parse(path.to_str().unwrap(), len, &mut entry);
        assert_eq!(
            entry.buckets[&("2026-07-01".into(), "unknown".into())].input,
            5
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ignores_a_missing_transcript() {
        let mut entry = SummaryEntry::default();
        parse("/nonexistent/transcript.jsonl", 100, &mut entry);
        assert!(entry.buckets.is_empty());
        assert_eq!(entry.offset, 0);
    }
}
