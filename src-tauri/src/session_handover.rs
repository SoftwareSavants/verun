//! One live Claude process per session.
//!
//! A Claude session can be driven from the chat UI (a warm stream-json process
//! in `ActiveMap`) or from the terminal (a `claude --resume` TUI in
//! `ClaudeTerminalMap`). Each process holds the conversation in memory, so if
//! both stay alive, whichever one speaks next appends to its own stale history
//! and the transcript forks. Before one mode speaks, the other mode's process
//! is retired; the next one resumes from the transcript on disk. A process
//! that is mid-turn is never killed - the switch is refused instead.
use crate::activity::Phase;

#[derive(Debug, PartialEq, Eq)]
pub enum Handover {
    /// Nothing from the other mode is alive.
    Clear,
    /// The other mode's process is idle and must be retired first.
    Retire,
    /// The other mode's process is mid-turn; switching would lose work.
    Blocked(&'static str),
}

pub const CHAT_BUSY: &str =
    "Claude is still answering in the chat view. Wait for it or stop it before switching to the terminal.";
pub const TERMINAL_BUSY: &str =
    "Claude is still working in the terminal view. Wait for it or interrupt it there before sending from the chat.";

/// Opening the terminal: `chat_busy` is `None` when no chat process is alive.
pub fn to_terminal(chat_busy: Option<bool>) -> Handover {
    match chat_busy {
        None => Handover::Clear,
        Some(true) => Handover::Blocked(CHAT_BUSY),
        Some(false) => Handover::Retire,
    }
}

/// Sending from the chat: `terminal` is `None` when no terminal is open,
/// otherwise the terminal's last observed activity phase (if any).
pub fn to_chat(terminal: Option<Option<Phase>>) -> Handover {
    match terminal {
        None => Handover::Clear,
        Some(Some(Phase::Working | Phase::Waiting)) => Handover::Blocked(TERMINAL_BUSY),
        Some(_) => Handover::Retire,
    }
}

/// Retire an idle chat process before the terminal takes the session over.
pub async fn hand_over_to_terminal(
    active: &crate::task::ActiveMap,
    session_id: &str,
) -> Result<(), String> {
    let busy = active
        .get(session_id)
        .map(|p| p.busy.load(std::sync::atomic::Ordering::SeqCst));
    match to_terminal(busy) {
        Handover::Clear => Ok(()),
        Handover::Blocked(why) => Err(why.into()),
        Handover::Retire => {
            crate::task::stop_active_sessions(active, &[session_id.to_string()]).await;
            Ok(())
        }
    }
}

/// Close an idle terminal before the chat speaks, and drop any chat process
/// warmed up before the terminal's turns so the next send resumes from disk.
pub async fn hand_over_to_chat(
    app: &tauri::AppHandle,
    active: &crate::task::ActiveMap,
    session_id: &str,
) -> Result<(), String> {
    use tauri::Manager;
    let Some(ct_map) = app.try_state::<crate::claude_terminal::ClaudeTerminalMap>() else {
        return Ok(());
    };
    let terminal = ct_map.contains_key(session_id).then(|| {
        app.try_state::<crate::activity::ActivityStore>()
            .and_then(|store| store.phase(session_id))
    });
    match to_chat(terminal) {
        Handover::Clear => Ok(()),
        Handover::Blocked(why) => Err(why.into()),
        Handover::Retire => {
            let pty_map = app
                .try_state::<crate::pty::ActivePtyMap>()
                .ok_or("terminal state unavailable")?;
            crate::claude_terminal::close_claude_terminal(
                pty_map.inner().clone(),
                ct_map.inner().clone(),
                session_id.to_string(),
            )
            .await?;
            crate::task::stop_active_sessions(active, &[session_id.to_string()]).await;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_takes_over_only_from_an_idle_chat() {
        assert_eq!(to_terminal(None), Handover::Clear);
        assert_eq!(to_terminal(Some(false)), Handover::Retire);
        assert_eq!(to_terminal(Some(true)), Handover::Blocked(CHAT_BUSY));
    }

    #[test]
    fn chat_takes_over_only_from_a_terminal_that_is_not_mid_turn() {
        assert_eq!(to_chat(None), Handover::Clear);
        for phase in [None, Some(Phase::Idle), Some(Phase::Unknown), Some(Phase::Ended), Some(Phase::Failed)] {
            assert_eq!(to_chat(Some(phase)), Handover::Retire, "{phase:?}");
        }
        for phase in [Phase::Working, Phase::Waiting] {
            assert_eq!(to_chat(Some(Some(phase))), Handover::Blocked(TERMINAL_BUSY));
        }
    }
}
