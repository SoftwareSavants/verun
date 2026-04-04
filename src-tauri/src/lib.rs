mod agent;
mod db;
mod ipc;
mod stream;
mod worktree;

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
        .manage(agent::new_agent_map())
        .invoke_handler(tauri::generate_handler![
            ipc::spawn_agent,
            ipc::kill_agent,
            ipc::restart_agent,
            ipc::list_agents,
            ipc::create_worktree,
            ipc::delete_worktree,
            ipc::list_worktrees,
            ipc::get_session,
            ipc::open_in_finder,
            ipc::get_diff,
            ipc::merge_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Verun");
}
