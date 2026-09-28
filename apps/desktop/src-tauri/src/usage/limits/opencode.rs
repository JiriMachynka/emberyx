//! OpenCode: only the Go subscription has plan windows, read from its usage
//! endpoint with the key OpenCode stored for the `opencode-go` provider.
//! Every other OpenCode provider is pay-per-token and has nothing to show.

use std::path::PathBuf;

use serde_json::Value;

use super::{get_json, iso_secs, HttpError, LimitAccount, LimitSource, LimitStatus, LimitWindow, ProviderLimits};
use crate::time::now_ms;

const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

/// Go's windows are fractions of one monthly budget: 5 hours → 20%, a week →
/// 50%, the month → 100% (opencode.ai/docs/go).
const WINDOWS: [(&str, &str, Option<u64>); 3] = [
    ("rolling", "5-hour limit", Some(300)),
    ("weekly", "Weekly limit", Some(10_080)),
    ("monthly", "Monthly limit", None),
];

pub fn read() -> ProviderLimits {
    let key = data_dir()
        .map(|d| d.join("opencode/auth.json"))
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|auth| auth.pointer("/opencode-go/key").and_then(Value::as_str).map(String::from));
    let Some(key) = key else {
        return ProviderLimits::without(
            "opencode",
            LimitStatus::Unsupported,
            "Only OpenCode Go reports plan limits. Connect it with `/connect`.",
        );
    };
    match get_json(USAGE_URL, &[("Authorization", &format!("Bearer {key}"))]) {
        Ok(body) => from_usage(&body)
            .unwrap_or_else(|| ProviderLimits::without("opencode", LimitStatus::Failed, "OpenCode Go returned no usage.")),
        Err(HttpError::Unauthorized) => ProviderLimits::without(
            "opencode",
            LimitStatus::SignedOut,
            "OpenCode Go rejected the stored key. Reconnect it with `/connect`.",
        ),
        Err(HttpError::Other(e)) => ProviderLimits::without("opencode", LimitStatus::Failed, e),
    }
}

fn data_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::paths::home_dir().map(|h| h.join(".local/share")))
}

fn from_usage(body: &Value) -> Option<ProviderLimits> {
    let usage = body.get("usage")?;
    let windows: Vec<LimitWindow> = WINDOWS
        .iter()
        .filter_map(|(key, label, mins)| {
            let w = usage.get(*key)?;
            Some(LimitWindow {
                label: (*label).into(),
                used_percent: w.get("percent")?.as_f64()?,
                resets_at: iso_secs(&w["resetsAt"]),
                window_duration_mins: *mins,
            })
        })
        .collect();
    if windows.is_empty() {
        return None;
    }
    let account = LimitAccount {
        email: None,
        plan: Some("Go".into()),
    };
    Some(ProviderLimits::ok("opencode", windows, account, LimitSource::Live, now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Real reply (2026-09-28).
    #[test]
    fn usage_reply() {
        let body = json!({ "usage": {
            "rolling": { "status": "ok", "percent": 4, "resetsAt": "2026-09-28T17:37:03.489Z" },
            "weekly": { "status": "ok", "percent": 3, "resetsAt": "2026-10-05T00:00:00.000Z" },
            "monthly": { "status": "ok", "percent": 44, "resetsAt": "2026-10-14T07:44:11.000Z" }
        }});
        let l = from_usage(&body).unwrap();
        assert_eq!(l.windows.len(), 3);
        assert_eq!(l.windows[0].label, "5-hour limit");
        assert_eq!(l.windows[1].resets_at, Some(1_791_158_400));
        assert_eq!(l.windows[2].used_percent, 44.0);
    }
}
