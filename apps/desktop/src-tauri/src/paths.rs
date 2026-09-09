//! Well-known locations the app reads from other tools' config.
//!
//! `$HOME` is unset often enough (a launchd job, a stripped env) that every
//! caller has to handle its absence; returning `Option` rather than a guessed
//! path is what keeps a missing home reading as "nothing to scan" instead of
//! scanning `/`.

use std::path::PathBuf;

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
