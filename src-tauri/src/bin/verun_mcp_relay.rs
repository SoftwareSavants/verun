//! Per-session MCP relay: launched by Claude Code as the configured MCP
//! server, this binary forwards stdio to the Verun in-app host's Unix
//! socket. Reads `VERUN_TASK_ID` (optional - missing means anonymous
//! caller, only `all_projects=true` queries succeed) and
//! `VERUN_MCP_SOCKET` (required - host writes this when spawning the
//! Claude session).
//!
//! Unix-only: the relay speaks Unix domain sockets. On Windows the binary
//! still compiles (Tauri's externalBin sidecar bundling needs the file to
//! exist at build time) but `main` immediately exits with a clear message.

use std::process::ExitCode;

#[cfg(unix)]
#[tokio::main]
async fn main() -> ExitCode {
    use std::path::PathBuf;
    use verun_lib::mcp;

    let task_id = std::env::var("VERUN_TASK_ID").ok().filter(|s| !s.is_empty());
    let socket = match std::env::var("VERUN_MCP_SOCKET") {
        Ok(s) if !s.is_empty() => PathBuf::from(s),
        _ => {
            eprintln!(
                "verun-mcp-relay: VERUN_MCP_SOCKET is not set. The relay is meant to be \
                 launched by Verun as part of a Claude Code session, not run directly."
            );
            return ExitCode::from(2);
        }
    };

    if let Err(e) = mcp::run_relay(socket, task_id, tokio::io::stdin(), tokio::io::stdout()).await {
        eprintln!("verun-mcp-relay: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

#[cfg(not(unix))]
fn main() -> ExitCode {
    eprintln!("verun-mcp-relay: this build target does not support Unix domain sockets.");
    ExitCode::from(2)
}
