use std::fmt;

/// Error returned by every Tauri command. Serializes to a plain string, so the
/// frontend contract is unchanged (`invoke` rejects with the message), while
/// the Rust side gets `?` over io / json / string errors instead of a
/// `.map_err(|e| e.to_string())` on every call.
#[derive(Debug)]
pub struct Error(String);

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error(message.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error(s)
    }
}

impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Error(s.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error(e.to_string())
    }
}

impl From<std::string::FromUtf8Error> for Error {
    fn from(e: std::string::FromUtf8Error) -> Self {
        Error(e.to_string())
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error(e.to_string())
    }
}

impl From<tauri::Error> for Error {
    fn from(e: tauri::Error) -> Self {
        Error(e.to_string())
    }
}

/// Runs blocking work off the async runtime's worker threads, flattening the
/// join error into `Error`. Every async Tauri command that wraps a synchronous
/// helper goes through here rather than repeating the `spawn_blocking` /
/// `.await` / double-`?` dance.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await?
}

/// Async twins for synchronous commands, generated into a module's `cmd`
/// submodule and registered in `generate_handler!` as `module::cmd::name`, so
/// the frontend still invokes the same name.
///
/// A plain `fn` command runs on the main thread in Tauri v2 and freezes the
/// window for as long as it takes — a `git push`, a `git add -A` over the whole
/// tree. Each twin forwards to the synchronous function, which tests and other
/// modules keep calling directly, on the blocking pool.
///
/// - `name(args) -> T;` forwards a function returning `Result<T>`.
/// - `name(args) => T;` forwards an infallible one.
/// - `[LOCK] name(args) -> T;` holds `LOCK` for the call. Off the main thread,
///   commands no longer queue behind each other, so writes that would collide
///   on the same git lock file name the mutex that orders them.
#[macro_export]
macro_rules! offload {
    () => {};
    ($([$lock:path])? $name:ident($($arg:ident: $ty:ty),* $(,)?) -> $ret:ty; $($rest:tt)*) => {
        #[tauri::command]
        pub async fn $name($($arg: $ty),*) -> $crate::error::Result<$ret> {
            $crate::error::blocking(move || {
                $(let _serial = $lock.lock().unwrap_or_else(|e| e.into_inner());)?
                super::$name($($arg),*)
            })
            .await
        }
        $crate::offload!($($rest)*);
    };
    ($name:ident($($arg:ident: $ty:ty),* $(,)?) => $ret:ty; $($rest:tt)*) => {
        #[tauri::command]
        pub async fn $name($($arg: $ty),*) -> $crate::error::Result<$ret> {
            $crate::error::blocking(move || Ok(super::$name($($arg),*))).await
        }
        $crate::offload!($($rest)*);
    };
}

/// `format!`-style bail: `err!("not a directory: {}", path)`.
#[macro_export]
macro_rules! err {
    ($($arg:tt)*) => {
        $crate::error::Error::new(format!($($arg)*))
    };
}
