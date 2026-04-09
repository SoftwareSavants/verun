mod db;
mod git_ops;
mod github;
mod ipc;
mod policy;
mod pty;
mod stream;
mod task;
mod worktree;

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_sql::Builder as SqlBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:verun.db", db::migrations())
                .build(),
        )
        .manage(task::new_active_map())
        .manage(task::new_pending_approvals())
        .manage(task::new_pending_approval_meta())
        .manage(pty::new_active_pty_map())
        .setup(|app| {
            // Fix PATH for bundled .app / AppImage — the app inherits a minimal
            // system PATH that doesn't include Homebrew, nvm, etc.
            #[cfg(not(target_os = "windows"))]
            if let Ok(shell) = std::env::var("SHELL").or_else(|_| Ok::<_, std::env::VarError>("/bin/sh".to_string())) {
                if let Ok(output) = std::process::Command::new(&shell)
                    .args(["-lc", "echo $PATH"])
                    .output()
                {
                    if output.status.success() {
                        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        if !path.is_empty() {
                            std::env::set_var("PATH", &path);
                        }
                    }
                }
            }

            // Menu setup
            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::with_id("quit", "Quit Verun")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Verun")
                    .item(&PredefinedMenuItem::about(app, Some("About Verun"), None)?)
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
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .item(&PredefinedMenuItem::fullscreen(app, None)?)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
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

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                let _ = app.emit("confirm-quit", ());
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    // CMD+W: hide the window instead of closing the app
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.emit("confirm-quit", ());
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Projects
            ipc::add_project,
            ipc::list_projects,
            ipc::delete_project,
            ipc::update_project_base_branch,
            // Tasks
            ipc::create_task,
            ipc::list_tasks,
            ipc::get_task,
            ipc::delete_task,
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
            // Utility
            ipc::list_claude_skills,
            ipc::check_claude,
            ipc::read_text_file,
            ipc::open_in_finder,
            ipc::open_in_app,
            ipc::quit_app,
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
