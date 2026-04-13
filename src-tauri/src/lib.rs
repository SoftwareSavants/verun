pub mod agent;
mod claude_jsonl;
mod db;
mod env_path;
mod git_ops;
mod github;
mod ipc;
mod lsp;
mod policy;
mod pty;
mod snapshots;
mod stream;
mod task;
mod tsgo_check;
mod watcher;
mod worktree;

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use dashmap::DashMap;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::Builder as SqlBuilder;
use tauri_plugin_updater::UpdaterExt;

/// Maps task window labels → task IDs (for close event emission)
pub type WindowTaskMap = DashMap<String, String>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notifications::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:verun.db", db::migrations())
                .build(),
        )
        .manage(task::new_active_map())
        .manage(task::new_pending_approvals())
        .manage(task::new_pending_approval_meta())
        .manage(task::new_setup_in_progress())
        .manage(task::new_hook_pty_map())
        .manage(pty::new_active_pty_map())
        .manage(watcher::new_file_watcher_map())
        .manage(lsp::new_lsp_map())
        .manage(tsgo_check::new_tsgo_check_map())
        .manage(WindowTaskMap::new())
        .setup(|app| {
            // Capture the user's full PATH from their interactive shell so
            // children (agents, lsp, git, gh, ...) inherit nvm/homebrew/etc.
            // Then start the background watcher that re-captures whenever
            // the integrated terminal looks idle after a user command.
            env_path::reload_now();
            env_path::start_idle_watcher();

            // Menu setup
            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::with_id("quit", "Quit Verun")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let quick_open_item = MenuItemBuilder::with_id("quick-open", "Go to File…")
                    .accelerator("CmdOrCtrl+P")
                    .build(app)?;
                let update_item = MenuItemBuilder::with_id("check-updates", "Check for Updates…")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Verun")
                    .item(&PredefinedMenuItem::about(app, Some("About Verun"), None)?)
                    .item(&update_item)
                    .separator()
                    .item(&PredefinedMenuItem::services(app, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app, None)?)
                    .item(&PredefinedMenuItem::hide_others(app, None)?)
                    .item(&PredefinedMenuItem::show_all(app, None)?)
                    .separator()
                    .item(&quit_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&quick_open_item)
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .item(&window_menu)
                    .build()?;
                app.set_menu(menu)?;
            }

            let app_data_dir = app.path().app_data_dir().map_err(|e| {
                std::io::Error::other(format!("Failed to get app data dir: {e}"))
            })?;

            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                std::io::Error::other(format!("Failed to create app data dir: {e}"))
            })?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match db::connect(&app_data_dir).await {
                    Ok(pool) => {
                        let db_tx = db::spawn_write_queue(pool.clone());
                        let _ = db_tx.send(db::DbWrite::ResetRunningSessions).await;
                        handle.manage(pool);
                        handle.manage(db_tx);
                    }
                    Err(e) => {
                        eprintln!("[verun] failed to connect to database: {e}");
                    }
                }
            });

            // Auto-check for updates after a short delay
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                match update_handle.updater() {
                    Ok(updater) => match updater.check().await {
                        Ok(Some(update)) => {
                            let _ = update_handle.emit(
                                "update-available",
                                serde_json::json!({
                                    "version": update.version,
                                    "body": update.body.unwrap_or_default(),
                                }),
                            );
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[verun] update check failed: {e}");
                        }
                    },
                    Err(e) => {
                        eprintln!("[verun] updater init failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                let _ = app.emit("confirm-quit", ());
            }
            if event.id() == "quick-open" {
                let _ = app.emit("quick-open", ());
            }
            if event.id() == "check-updates" {
                let _ = app.emit("check-updates", ());
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    #[cfg(target_os = "macos")]
                    {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = window.emit("confirm-quit", ());
                        api.prevent_close();
                    }
                } else if window.label().starts_with("task-") {
                    if let Some(map) = window.try_state::<WindowTaskMap>() {
                        // Look up task ID for this window (clone + drop the Ref to release the read lock)
                        let task_id = map.get(window.label()).map(|e| e.value().clone());
                        if let Some(task_id) = task_id {
                            // Check if setup hook is running for this task
                            if let Some(sip) = window.try_state::<task::SetupInProgress>() {
                                if sip.contains_key(&task_id) {
                                    api.prevent_close();
                                    let _ = window.emit("confirm-close-setup", ());
                                    return;
                                }
                            }
                            // Setup not running — clean up and let close proceed
                            map.remove(window.label());
                            let _ = window.emit_to(
                                "main",
                                "task-window-changed",
                                serde_json::json!({ "taskId": task_id, "open": false }),
                            );
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Projects
            ipc::add_project,
            ipc::list_projects,
            ipc::delete_project,
            ipc::update_project_base_branch,
            ipc::update_project_hooks,
            ipc::export_project_config,
            ipc::import_project_config,
            // Tasks
            ipc::create_task,
            ipc::list_tasks,
            ipc::get_task,
            ipc::delete_task,
            ipc::archive_task,
            ipc::check_task_worktree,
            ipc::restore_task,
            ipc::rename_task,
            ipc::get_setup_in_progress,
            ipc::run_hook,
            ipc::stop_hook,
            // Sessions
            ipc::create_session,
            ipc::send_message,
            ipc::close_session,
            ipc::clear_session,
            ipc::abort_message,
            ipc::get_active_sessions,
            ipc::respond_to_approval,
            ipc::get_pending_approvals,
            ipc::list_sessions,
            ipc::get_session,
            ipc::get_output_lines,
            ipc::fork_session_in_task,
            ipc::fork_session_to_new_task,
            // Policy / Trust levels
            ipc::set_trust_level,
            ipc::get_trust_level,
            ipc::get_audit_log,
            // Git / Worktree
            ipc::get_diff,
            ipc::merge_branch,
            ipc::get_branch_status,
            ipc::get_repo_info,
            // Git operations
            ipc::get_git_status,
            ipc::get_file_diff,
            ipc::get_file_context,
            ipc::git_stage,
            ipc::git_unstage,
            ipc::git_commit,
            ipc::git_push,
            ipc::git_pull,
            ipc::git_commit_and_push,
            // Branch commits
            ipc::get_branch_commits,
            ipc::get_commit_files,
            ipc::get_commit_file_diff,
            ipc::get_file_diff_contents,
            ipc::get_commit_file_contents,
            // GitHub
            ipc::check_github,
            ipc::create_pull_request,
            ipc::mark_pr_ready,
            ipc::merge_pull_request,
            ipc::get_pull_request,
            ipc::git_ship,
            ipc::get_ci_checks,
            ipc::get_branch_url,
            ipc::has_conflicts,
            // PTY / Terminal
            ipc::pty_spawn,
            ipc::pty_write,
            ipc::pty_resize,
            ipc::pty_close,
            // Clipboard
            ipc::read_clipboard,
            ipc::copy_image_to_clipboard,
            ipc::write_binary_file,
            // Utility
            ipc::list_claude_skills,
            ipc::check_claude,
            ipc::check_agent,
            ipc::list_available_agents,
            ipc::reload_env_path,
            ipc::list_worktree_files,
            ipc::check_gitignored,
            ipc::read_text_file,
            ipc::open_in_finder,
            ipc::open_in_app,
            ipc::quit_app,
            // File tree
            ipc::list_directory,
            ipc::read_worktree_file,
            ipc::resolve_worktree_file_path,
            ipc::write_text_file,
            ipc::watch_worktree,
            ipc::unwatch_worktree,
            // LSP
            ipc::lsp_start,
            ipc::lsp_send,
            ipc::lsp_stop,
            ipc::tsgo_check_run,
            ipc::tsgo_check_cancel,
            // Notifications (debug-only: test click navigation from devtools)
            #[cfg(debug_assertions)]
            ipc::debug_navigate_to_task,
            // Steps
            ipc::list_steps,
            ipc::add_step,
            ipc::update_step,
            ipc::delete_step,
            ipc::reorder_steps,
            ipc::disarm_all_steps,
            // Window management
            ipc::open_task_window,
            ipc::open_new_task_window,
            ipc::force_close_task_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Verun")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            RunEvent::ExitRequested { api, .. } => {
                // Intercept quit and ask frontend for confirmation
                api.prevent_exit();
                let _ = app_handle.emit("confirm-quit", ());
            }
            _ => {}
        });
}
