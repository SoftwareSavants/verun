//! Keep the Mac awake: automatically while agents are working, or on demand
//! for a set time (screen included) so Verun works as a standalone caffeine
//! tool. Backed by macOS `caffeinate`, bound to Verun's pid with `-w` so it
//! can never outlive the app.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Manual {
    Off,
    /// Epoch milliseconds.
    Until(u64),
    Forever,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Agents are working: block idle and system sleep, let the screen dim.
    System,
    /// The user asked: keep the screen on too.
    Display,
}

/// What to hold right now. Manual wins over auto because it also keeps the screen on.
pub fn wanted(auto_working: bool, manual: Manual, now_ms: u64) -> Option<Mode> {
    let manual_on = match manual {
        Manual::Off => false,
        Manual::Until(deadline) => now_ms < deadline,
        Manual::Forever => true,
    };
    if manual_on {
        Some(Mode::Display)
    } else if auto_working {
        Some(Mode::System)
    } else {
        None
    }
}

pub fn caffeinate_args(mode: Mode, pid: u32) -> Vec<String> {
    // -i: no idle sleep, -s: no system sleep on AC power, -d: no display sleep.
    let mut args = vec!["-i".to_string(), "-s".to_string()];
    if mode == Mode::Display {
        args.push("-d".into());
    }
    args.extend(["-w".into(), pid.to_string()]);
    args
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    /// Some agent is working right now (as reported by the frontend's status model).
    pub agents_working: bool,
    /// Epoch ms when the manual hold ends; `None` with `manual_forever` false means off.
    pub manual_until: Option<u64>,
    pub manual_forever: bool,
    /// A `caffeinate` assertion is held right now.
    pub active: bool,
    pub keeps_screen_on: bool,
}

struct Inner {
    auto_working: bool,
    manual: Manual,
    mode: Option<Mode>,
    child: Option<std::process::Child>,
    timer: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub struct KeepAwake(Mutex<Inner>);

impl Default for KeepAwake {
    fn default() -> Self {
        Self(Mutex::new(Inner {
            auto_working: false,
            manual: Manual::Off,
            mode: None,
            child: None,
            timer: None,
        }))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn status_of(inner: &Inner) -> KeepAwakeStatus {
    KeepAwakeStatus {
        agents_working: inner.auto_working,
        manual_until: match inner.manual {
            Manual::Until(t) => Some(t),
            _ => None,
        },
        manual_forever: inner.manual == Manual::Forever,
        active: inner.mode.is_some(),
        keeps_screen_on: inner.mode == Some(Mode::Display),
    }
}

impl KeepAwake {
    pub fn status(&self) -> KeepAwakeStatus {
        status_of(&self.0.lock().unwrap())
    }

    /// Reconcile the held assertion with the wanted one and broadcast the result.
    fn apply(&self, app: &AppHandle) {
        let status = {
            let mut inner = self.0.lock().unwrap();
            if matches!(inner.manual, Manual::Until(t) if now_ms() >= t) {
                inner.manual = Manual::Off;
            }
            let want = wanted(inner.auto_working, inner.manual, now_ms());
            if want != inner.mode {
                if let Some(mut child) = inner.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                inner.mode = None;
                if let Some(mode) = want {
                    match std::process::Command::new("/usr/bin/caffeinate")
                        .args(caffeinate_args(mode, std::process::id()))
                        .spawn()
                    {
                        Ok(child) => {
                            inner.child = Some(child);
                            inner.mode = Some(mode);
                        }
                        Err(e) => eprintln!("[verun][keep-awake] caffeinate failed: {e}"),
                    }
                }
            }
            status_of(&inner)
        };
        let _ = app.emit("keep-awake-changed", status);
    }

    fn set_manual(&self, app: &AppHandle, manual: Manual) {
        {
            let mut inner = self.0.lock().unwrap();
            inner.manual = manual;
            if let Some(timer) = inner.timer.take() {
                timer.abort();
            }
            if let Manual::Until(deadline) = manual {
                let app = app.clone();
                let wait = deadline.saturating_sub(now_ms());
                inner.timer = Some(tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                    app.state::<KeepAwake>().apply(&app);
                }));
            }
        }
        self.apply(app);
    }
}

#[tauri::command]
pub fn keep_awake_status(state: tauri::State<'_, KeepAwake>) -> KeepAwakeStatus {
    state.status()
}

/// Called by the frontend when "any agent working" flips.
#[tauri::command]
pub fn keep_awake_set_agents_working(app: AppHandle, state: tauri::State<'_, KeepAwake>, working: bool) {
    state.0.lock().unwrap().auto_working = working;
    state.apply(&app);
}

/// `minutes: None` keeps the screen on until turned off.
#[tauri::command]
pub fn keep_awake_set_manual(app: AppHandle, state: tauri::State<'_, KeepAwake>, minutes: Option<u32>) {
    let manual = match minutes {
        Some(m) => Manual::Until(now_ms() + u64::from(m) * 60_000),
        None => Manual::Forever,
    };
    state.set_manual(&app, manual);
}

#[tauri::command]
pub fn keep_awake_clear_manual(app: AppHandle, state: tauri::State<'_, KeepAwake>) {
    state.set_manual(&app, Manual::Off);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_held_when_idle_and_no_manual_hold() {
        assert_eq!(wanted(false, Manual::Off, 10), None);
    }

    #[test]
    fn working_agents_hold_the_system_but_not_the_screen() {
        assert_eq!(wanted(true, Manual::Off, 10), Some(Mode::System));
        assert_eq!(caffeinate_args(Mode::System, 42), ["-i", "-s", "-w", "42"]);
    }

    #[test]
    fn manual_hold_keeps_the_screen_on_until_it_expires() {
        assert_eq!(wanted(false, Manual::Until(100), 99), Some(Mode::Display));
        assert_eq!(wanted(false, Manual::Until(100), 100), None);
        assert_eq!(wanted(true, Manual::Until(100), 150), Some(Mode::System));
        assert_eq!(wanted(false, Manual::Forever, u64::MAX), Some(Mode::Display));
        assert_eq!(caffeinate_args(Mode::Display, 7), ["-i", "-s", "-d", "-w", "7"]);
    }
}
