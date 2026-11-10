//! Remember which task windows are open, and where, so a relaunch puts them
//! back. The list lives in `open-windows.json` in the app data dir and is
//! rewritten on every change (opens, closes, moves, resizes), so it is right
//! even when the app quits through `process::exit` or crashes.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn overlap(&self, other: &Rect) -> f64 {
        let w = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let h = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        if w > 0.0 && h > 0.0 {
            w * h
        } else {
            0.0
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWindow {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
}

/// The open task windows, oldest first, so restoring in order leaves the
/// most recently opened one in front.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WindowList {
    pub windows: Vec<SavedWindow>,
}

impl WindowList {
    /// Returns whether the list changed.
    pub fn opened(&mut self, task_id: &str) -> bool {
        if self.windows.iter().any(|w| w.task_id == task_id) {
            return false;
        }
        self.windows.push(SavedWindow { task_id: task_id.to_string(), rect: None });
        true
    }

    pub fn closed(&mut self, task_id: &str) -> bool {
        let before = self.windows.len();
        self.windows.retain(|w| w.task_id != task_id);
        self.windows.len() != before
    }

    /// Only windows already in the list get a geometry; a move event for a
    /// window being closed must not bring it back.
    pub fn moved(&mut self, task_id: &str, rect: Rect) -> bool {
        match self.windows.iter_mut().find(|w| w.task_id == task_id) {
            Some(w) if w.rect != Some(rect) => {
                w.rect = Some(rect);
                true
            }
            _ => false,
        }
    }

    pub fn parse(json: &str) -> Self {
        serde_json::from_str(json).unwrap_or_default()
    }
}

/// Keep a saved position only if enough of the window is still on a screen;
/// a monitor that was unplugged would otherwise open it out of reach.
pub fn placement(rect: Rect, monitors: &[Rect]) -> Option<Rect> {
    let area = rect.width * rect.height;
    if area <= 0.0 {
        return None;
    }
    let visible: f64 = monitors.iter().map(|m| rect.overlap(m)).sum();
    (visible / area >= 0.25).then_some(rect)
}

pub fn file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("open-windows.json")
}

pub fn load(path: &Path) -> WindowList {
    std::fs::read_to_string(path)
        .map(|s| WindowList::parse(&s))
        .unwrap_or_default()
}

fn write(path: &Path, list: &WindowList) {
    let Ok(json) = serde_json::to_string_pretty(list) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Managed state. Writes go to one background thread that only keeps the
/// latest snapshot, so a window drag does not queue hundreds of writes.
pub struct WindowSession {
    list: Mutex<WindowList>,
    tx: mpsc::Sender<WindowList>,
}

impl WindowSession {
    pub fn new(path: PathBuf, initial: WindowList) -> Self {
        let (tx, rx) = mpsc::channel::<WindowList>();
        std::thread::spawn(move || {
            while let Ok(mut latest) = rx.recv() {
                while let Ok(newer) = rx.try_recv() {
                    latest = newer;
                }
                write(&path, &latest);
            }
        });
        Self { list: Mutex::new(initial), tx }
    }

    pub fn snapshot(&self) -> WindowList {
        self.list.lock().unwrap().clone()
    }

    fn update(&self, f: impl FnOnce(&mut WindowList) -> bool) {
        let mut list = self.list.lock().unwrap();
        if f(&mut list) {
            let _ = self.tx.send(list.clone());
        }
    }

    pub fn opened(&self, task_id: &str) {
        self.update(|l| l.opened(task_id));
    }

    pub fn closed(&self, task_id: &str) {
        self.update(|l| l.closed(task_id));
    }

    pub fn moved(&self, task_id: &str, rect: Rect) {
        self.update(|l| l.moved(task_id, rect));
    }

    /// Drop windows that can't be restored (task deleted or archived).
    pub fn retain(&self, keep: impl Fn(&str) -> bool) {
        self.update(|l| {
            let before = l.windows.len();
            l.windows.retain(|w| keep(&w.task_id));
            l.windows.len() != before
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, width: w, height: h }
    }

    #[test]
    fn opening_appends_once_and_closing_removes() {
        let mut l = WindowList::default();
        assert!(l.opened("a"));
        assert!(l.opened("b"));
        assert!(!l.opened("a"));
        assert_eq!(l.windows.iter().map(|w| w.task_id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(l.closed("a"));
        assert!(!l.closed("a"));
        assert_eq!(l.windows.len(), 1);
    }

    #[test]
    fn moving_updates_known_windows_only() {
        let mut l = WindowList::default();
        l.opened("a");
        assert!(l.moved("a", rect(10.0, 20.0, 800.0, 600.0)));
        assert!(!l.moved("a", rect(10.0, 20.0, 800.0, 600.0)));
        assert!(!l.moved("gone", rect(0.0, 0.0, 800.0, 600.0)));
        assert_eq!(l.windows[0].rect, Some(rect(10.0, 20.0, 800.0, 600.0)));
        assert_eq!(l.windows.len(), 1);
    }

    #[test]
    fn reopening_a_window_keeps_its_geometry() {
        let mut l = WindowList::default();
        l.opened("a");
        l.moved("a", rect(1.0, 2.0, 900.0, 700.0));
        l.opened("a");
        assert_eq!(l.windows[0].rect, Some(rect(1.0, 2.0, 900.0, 700.0)));
    }

    #[test]
    fn parse_tolerates_missing_or_corrupt_files() {
        assert_eq!(WindowList::parse(""), WindowList::default());
        assert_eq!(WindowList::parse("{not json"), WindowList::default());
        let l = WindowList::parse(r#"{"windows":[{"taskId":"a"},{"taskId":"b","rect":{"x":1,"y":2,"width":3,"height":4}}]}"#);
        assert_eq!(l.windows.len(), 2);
        assert_eq!(l.windows[0].rect, None);
        assert_eq!(l.windows[1].rect, Some(rect(1.0, 2.0, 3.0, 4.0)));
    }

    #[test]
    fn placement_drops_positions_that_are_off_screen() {
        let screens = [rect(0.0, 0.0, 1440.0, 900.0)];
        let on = rect(100.0, 100.0, 1200.0, 800.0);
        assert_eq!(placement(on, &screens), Some(on));
        // Mostly on a monitor that is gone.
        assert_eq!(placement(rect(1400.0, 0.0, 1200.0, 800.0), &screens), None);
        // Spans two monitors.
        let two = [rect(0.0, 0.0, 1440.0, 900.0), rect(1440.0, 0.0, 1920.0, 1080.0)];
        assert!(placement(rect(1000.0, 0.0, 1200.0, 800.0), &two).is_some());
        assert_eq!(placement(rect(0.0, 0.0, 0.0, 0.0), &screens), None);
    }

    #[test]
    fn session_persists_changes_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = file_path(dir.path());
        let s = WindowSession::new(path.clone(), load(&path));
        s.opened("a");
        s.opened("b");
        s.moved("b", rect(5.0, 6.0, 800.0, 600.0));
        s.closed("a");
        let want = s.snapshot();
        for _ in 0..100 {
            if load(&path) == want {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(load(&path), want);
        assert_eq!(want.windows.len(), 1);
        assert_eq!(want.windows[0].task_id, "b");
    }

    #[test]
    fn retain_drops_unrestorable_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let s = WindowSession::new(file_path(dir.path()), WindowList::default());
        s.opened("a");
        s.opened("archived");
        s.retain(|id| id != "archived");
        assert_eq!(s.snapshot().windows.len(), 1);
    }
}
