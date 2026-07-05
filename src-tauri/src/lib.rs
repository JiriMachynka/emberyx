mod dokploy;
mod git;
mod hooks;
mod pty;
mod threads;
mod usage;
mod workspace;

use pty::PtyManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(PtyManager::new())
        .manage(usage::UsageCache::default())
        .setup(|app| {
            let config = hooks::start(&app.handle())?;
            app.manage(config);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::read_scrollback,
            workspace::scan_workspace,
            hooks::hook_config,
            git::git_changes,
            git::git_file_diff,
            git::git_commit,
            usage::read_usage,
            threads::list_threads,
            dokploy::dokploy_services,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
