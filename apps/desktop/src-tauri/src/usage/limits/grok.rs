//! Grok: the ACP extension `_x.ai/billing` on a one-shot `grok agent stdio`.
//! The un-prefixed `x.ai/billing` answers "Method not found" (grok 1.0.41).

use serde_json::{json, Value};

use super::{capitalize, iso_secs, rpc_oneshot, LimitAccount, LimitSource, LimitStatus, LimitWindow, ProviderLimits};
use crate::time::now_ms;

pub fn read(binary: &str) -> ProviderLimits {
    let email = crate::paths::home_dir()
        .map(|h| h.join(".grok/auth.json"))
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|auth| {
            // Keyed by issuer + client id; one entry per signed-in identity.
            let first = auth.as_object()?.values().next()?.clone();
            Some(first["email"].as_str().map(String::from))
        });
    let Some(email) = email else {
        return ProviderLimits::without("grok", LimitStatus::SignedOut, "Sign in with `grok` to see your limits.");
    };
    match rpc_oneshot(
        binary,
        &["agent", "stdio"],
        json!({ "protocolVersion": 1, "clientCapabilities": {} }),
        &[("_x.ai/billing", json!({}))],
    ) {
        Ok(replies) => from_billing(&replies[0], email)
            .unwrap_or_else(|| ProviderLimits::without("grok", LimitStatus::Failed, "Grok returned no billing period.")),
        Err(e) => ProviderLimits::without("grok", LimitStatus::Failed, e.to_string()),
    }
}

fn from_billing(reply: &Value, email: Option<String>) -> Option<ProviderLimits> {
    let config = reply.get("config")?;
    let period = &config["currentPeriod"];
    let (start, end) = (iso_secs(&period["start"]), iso_secs(&period["end"]));
    let label = match period["type"].as_str() {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "Weekly limit".to_string(),
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "Monthly limit".to_string(),
        Some("USAGE_PERIOD_TYPE_DAILY") => "Daily limit".to_string(),
        _ => "Usage limit".to_string(),
    };
    let window = LimitWindow {
        label,
        used_percent: config.get("creditUsagePercent")?.as_f64()?,
        resets_at: end,
        window_duration_mins: start.zip(end).map(|(s, e)| ((e - s).max(0) / 60) as u64),
    };
    let account = LimitAccount {
        email,
        plan: reply["subscription_tier"].as_str().map(capitalize),
    };
    Some(ProviderLimits::ok("grok", vec![window], account, LimitSource::Cli, now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real `_x.ai/billing` reply from grok 1.0.41 (2026-09-28).
    #[test]
    fn billing_reply() {
        let reply = json!({
            "config": {
                "creditUsagePercent": 59.0,
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-09-24T09:39:51.462714+00:00",
                    "end": "2026-10-01T09:39:51.462714+00:00"
                },
                "isUnifiedBillingUser": true
            },
            "subscription_tier": "SuperGrok Plus"
        });
        let l = from_billing(&reply, Some("a@b.c".into())).unwrap();
        assert_eq!(l.windows[0].label, "Weekly limit");
        assert_eq!(l.windows[0].used_percent, 59.0);
        assert_eq!(l.windows[0].window_duration_mins, Some(10_080));
        assert_eq!(l.account.plan.as_deref(), Some("SuperGrok Plus"));
    }

    #[test]
    fn missing_config_is_not_a_reading() {
        assert!(from_billing(&json!({}), None).is_none());
    }
}
