mod agent;
mod ask;
mod codex;
mod defs;
mod dokploy;
mod error;
mod files;
mod fs_walk;
mod git;
mod gitlab;
mod hooks;
mod icon;
mod menu;
mod openrouter;
mod pty;
mod search;
mod slash;
mod supervisor;
mod threads;
mod usage;
mod workspace;

use agent::AgentManager;
use codex::CodexManager;
use pty::PtyManager;
use supervisor::Supervisor;
use tauri::Manager;
use tauri::path::BaseDirectory;

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
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .manage(PtyManager::new())
        .manage(AgentManager::new())
        .manage(CodexManager::new())
        .manage(Supervisor::new())
        .manage(usage::UsageCache::default())
        .manage(usage::SummaryCache::default())
        .setup(|app| {
            if let Ok(path) = app.path().resolve("registry.json", BaseDirectory::AppData) {
                let _ = app.state::<Supervisor>().restore(&path);
            }
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
            codex::codex_spawn,
            codex::codex_kill,
            codex::codex_request,
            codex::codex_respond,
            codex::codex_thread_start,
            codex::codex_thread_resume,
            codex::codex_thread_fork,
            codex::codex_thread_list,
            codex::codex_thread_compact,
            codex::codex_turn_start,
            codex::codex_turn_steer,
            codex::codex_turn_interrupt,
            codex::codex_hooks_list,
            codex::codex_rate_limits,
            codex::codex_usage,
            supervisor::agent_register,
            supervisor::agent_attach_thread,
            supervisor::agent_attach_turn,
            supervisor::agent_complete_turn,
            supervisor::agent_list,
            supervisor::agent_get,
            supervisor::agent_read,
            supervisor::agent_wait,
            supervisor::agent_interrupt,
            supervisor::agent_stop,
            supervisor::agent_kill_managed,
            supervisor::agent_set_state,
            supervisor::agent_subscribe,
            supervisor::agent_prompt,
            supervisor::agent_delegate,
            supervisor::agent_delegation_get,
            supervisor::agent_delegation_cancel,
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
            git::git_log,
            git::git_commit_diff,
            git::git_pickaxe,
            git::git_branch,
            git::git_branches,
            git::git_pull,
            git::git_push,
            git::git_push_to,
            git::git_checkout,
            git::git_branch_delete,
            git::git_worktrees,
            git::git_repo_root,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::git_stash_push,
            git::git_stash_list,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_fetch,
            git::git_checkout_remote,
            git::git_merge,
            git::git_conflicts,
            git::git_conflict_stages,
            git::git_resolve,
            git::git_merge_abort,
            git::git_merge_continue,
            git::git_merge_state,
            git::git_remote_host,
            gitlab::gitlab_set_token,
            gitlab::gitlab_has_token,
            gitlab::gitlab_clear_token,
            gitlab::gitlab_mrs,
            gitlab::gitlab_mr,
            gitlab::gitlab_mr_diff,
            gitlab::gitlab_mr_notes,
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
            if let Ok(path) = app_handle
                .path()
                .resolve("registry.json", BaseDirectory::AppData)
            {
                let _ = app_handle.state::<Supervisor>().persist(&path);
            }
            app_handle.state::<AgentManager>().kill_all();
            app_handle.state::<CodexManager>().kill_all();
            app_handle.state::<PtyManager>().kill_all();
            app_handle.state::<Supervisor>().kill_all();
        }
    });
}
