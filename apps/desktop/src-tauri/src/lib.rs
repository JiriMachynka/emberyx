mod agent;
mod ask;
mod defs;
mod dokploy;
mod error;
mod files;
mod fs_walk;
mod git;
mod hooks;
mod icon;
mod openrouter;
mod pty;
mod search;
mod slash;
mod threads;
mod usage;
mod workspace;

use agent::AgentManager;
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

    let app = builder
        .manage(PtyManager::new())
        .manage(AgentManager::new())
        .manage(usage::UsageCache::default())
        .manage(usage::SummaryCache::default())
        .setup(|app| {
            let config = hooks::start(app.handle())?;
            app.manage(config);
            app.manage(ask::start(app.handle())?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::read_scrollback,
            agent::agent_spawn,
            agent::agent_send,
            agent::agent_kill,
            agent::title_thread,
            ask::answer_ask,
            workspace::scan_workspace,
            files::list_dir,
            files::list_files,
            defs::find_definition,
            defs::resolve_import,
            defs::hover_info,
            files::read_text_file,
            files::write_text_file,
            search::search_text,
            slash::slash_commands,
            icon::project_icon,
            hooks::hook_config,
            git::git_changes,
            git::git_file_diff,
            git::git_commit,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_apply,
            git::git_file_log,
            git::git_show_file,
            git::git_pickaxe,
            git::git_branch,
            git::git_branches,
            git::git_pull,
            git::git_push,
            git::git_push_to,
            git::git_checkout,
            git::git_branch_delete,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_apply,
            git::git_stash_drop,
            usage::read_usage,
            usage::usage_summary,
            threads::list_threads,
            threads::read_thread,
            dokploy::dokploy_services,
            dokploy::dokploy_redeploy,
            dokploy::dokploy_logs,
            openrouter::generate_commit_message,
            openrouter::openrouter_models,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Managed state isn't dropped on exit, so kill + reap spawned children here
    // or orphaned headless `claude` processes and PTY shells keep running.
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            app_handle.state::<AgentManager>().kill_all();
            app_handle.state::<PtyManager>().kill_all();
        }
    });
}
