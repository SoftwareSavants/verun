//! Raise the process's open-file soft limit at startup.
//!
//! macOS ships with a default `RLIMIT_NOFILE` soft limit of 256, which is
//! trivially exhausted once several tasks are open: each holds an LSP child,
//! a codex app-server child (3 piped FDs per session since the 0.9 migration),
//! one or more PTYs, and a notify watcher. Adding a burst of `git` subprocess
//! spawns on top of that (e.g. the sidebar's per-task git refresh fanning
//! out when a task is added) reliably hits EMFILE. Bumping the soft limit to
//! something well above normal usage costs nothing and removes the ceiling.

use std::io;

/// Raise the `RLIMIT_NOFILE` soft limit to `min(desired, hard_limit)` when it
/// is currently below that. Returns `(previous_soft, new_soft)`.
#[cfg(unix)]
pub fn raise_fd_limit_to(desired: u64) -> io::Result<(u64, u64)> {
    let mut rlim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let got = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) };
    if got != 0 {
        return Err(io::Error::last_os_error());
    }
    let prev_soft = rlim.rlim_cur;
    let hard = rlim.rlim_max;
    let target = desired.min(hard);
    if target <= prev_soft {
        return Ok((prev_soft, prev_soft));
    }
    rlim.rlim_cur = target;
    let set = unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &rlim) };
    if set != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((prev_soft, target))
}

/// Default target used by `lib.rs` at startup. 8192 is well above what any
/// realistic verun usage needs but below macOS's typical hard limit.
pub const DEFAULT_TARGET: u64 = 8192;

#[cfg(unix)]
pub fn raise_fd_limit() -> io::Result<(u64, u64)> {
    raise_fd_limit_to(DEFAULT_TARGET)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current_soft() -> u64 {
        let mut rlim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        let rc = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) };
        assert_eq!(rc, 0);
        rlim.rlim_cur
    }

    fn current_hard() -> u64 {
        let mut rlim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        let rc = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) };
        assert_eq!(rc, 0);
        rlim.rlim_max
    }

    #[test]
    fn raises_soft_limit_to_desired_when_below_hard() {
        let hard = current_hard();
        let target = 4096u64.min(hard);
        let (_prev, new_soft) = raise_fd_limit_to(target).expect("setrlimit failed");
        assert!(new_soft >= target, "new_soft={new_soft} < target={target}");
        assert!(current_soft() >= target);
    }

    #[test]
    fn caps_at_hard_limit() {
        let hard = current_hard();
        // Ask for more than the hard limit — result must not exceed hard.
        let (_prev, new_soft) = raise_fd_limit_to(hard.saturating_add(1_000_000))
            .expect("setrlimit failed");
        assert!(new_soft <= hard, "new_soft={new_soft} > hard={hard}");
    }

    #[test]
    fn idempotent_when_already_above_desired() {
        // Raise once, then ask for less — should be a no-op, prev == new.
        let hard = current_hard();
        let high = 4096u64.min(hard);
        let _ = raise_fd_limit_to(high).expect("first raise failed");
        let (prev, new) = raise_fd_limit_to(256).expect("second raise failed");
        assert_eq!(prev, new, "expected no-op when desired <= current soft");
    }
}
