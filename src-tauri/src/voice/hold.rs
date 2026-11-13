//! Pure hold-to-talk key logic: turns raw key events into dictation actions.
//! Platform independent; the macOS event tap in `hotkey_macos` feeds it.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A hold arms this long after key down. A release or another key before then
/// (a tap, Fn+arrow, Fn+Delete) never opens the microphone.
pub const ARM_DELAY: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HoldKey {
    #[default]
    Fn,
    RightOption,
    RightCommand,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyEvent {
    HoldDown,
    HoldUp,
    OtherKeyDown,
}

#[derive(Debug, PartialEq)]
pub enum HoldAction {
    /// Start a take for `window`, the window focused at key down. The take is
    /// timed from `down_at`, so the minimum hold counts from key down.
    Begin { window: String, down_at: Instant },
    End,
    Cancel,
    None,
}

enum Phase {
    Up,
    /// Down for a focused window, not armed yet.
    Arming { window: String, down_at: Instant },
    /// Down and a take was begun for it.
    Active,
}

/// Fed key events and the time; arms a hold `ARM_DELAY` after key down.
pub struct HoldDetector {
    phase: Phase,
}

impl Default for HoldDetector {
    fn default() -> Self {
        Self { phase: Phase::Up }
    }
}

impl HoldDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// A key event at `now`. `focused` (the focused Verun window) only matters
    /// for `HoldDown`: a release always ends a hold that began, even if focus
    /// moved away meanwhile. Call `on_time(now)` first so a deadline that
    /// passed before this event is honoured.
    pub fn on_key(&mut self, ev: KeyEvent, focused: Option<String>, now: Instant) -> HoldAction {
        match (ev, &self.phase) {
            (KeyEvent::HoldDown, Phase::Up) => {
                if let Some(window) = focused {
                    self.phase = Phase::Arming { window, down_at: now };
                }
                HoldAction::None
            }
            (KeyEvent::HoldUp | KeyEvent::OtherKeyDown, Phase::Arming { .. }) => {
                self.phase = Phase::Up;
                HoldAction::None
            }
            (KeyEvent::HoldUp, Phase::Active) => {
                self.phase = Phase::Up;
                HoldAction::End
            }
            (KeyEvent::OtherKeyDown, Phase::Active) => {
                self.phase = Phase::Up;
                HoldAction::Cancel
            }
            _ => HoldAction::None,
        }
    }

    /// Arms a pending hold once `ARM_DELAY` has passed since its key down.
    pub fn on_time(&mut self, now: Instant) -> HoldAction {
        let due = matches!(&self.phase, Phase::Arming { down_at, .. } if now >= *down_at + ARM_DELAY);
        if !due {
            return HoldAction::None;
        }
        match std::mem::replace(&mut self.phase, Phase::Active) {
            Phase::Arming { window, down_at } => HoldAction::Begin { window, down_at },
            _ => HoldAction::None,
        }
    }

    /// When the pending hold arms, if one is pending.
    pub fn deadline(&self) -> Option<Instant> {
        match &self.phase {
            Phase::Arming { down_at, .. } => Some(*down_at + ARM_DELAY),
            _ => None,
        }
    }

    /// The window `label` is gone: a hold pending for it never arms.
    pub fn forget_window(&mut self, label: &str) {
        if matches!(&self.phase, Phase::Arming { window, .. } if window == label) {
            self.phase = Phase::Up;
        }
    }
}

/// Lets through, on the tap thread, only the key events the hold logic needs:
/// the hold key's own presses and releases, and other keys only while the
/// hold key is down. Ordinary typing in any app then wakes nothing. It opens
/// on the hold key's press inside the tap callback itself, so a key pressed
/// right after it (during the arming delay) is never missed.
#[derive(Default)]
pub struct KeyGate {
    hold_down: std::cell::Cell<bool>,
}

impl KeyGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether `ev` should be forwarded.
    pub fn pass(&self, ev: KeyEvent) -> bool {
        match ev {
            KeyEvent::HoldDown => self.hold_down.set(true),
            KeyEvent::HoldUp => self.hold_down.set(false),
            KeyEvent::OtherKeyDown => return self.hold_down.get(),
        }
        true
    }
}

/// What macOS does when Fn (the Globe key) is pressed, from Keyboard settings.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FnSystemAction {
    None,
    InputSource,
    Emoji,
    Dictation,
    Unknown,
}

/// Maps the `AppleFnUsageType` user default (domain `com.apple.HIToolbox`).
pub fn fn_action_from_pref(value: Option<i64>) -> FnSystemAction {
    match value {
        Some(0) => FnSystemAction::None,
        Some(1) => FnSystemAction::InputSource,
        Some(2) => FnSystemAction::Emoji,
        Some(3) => FnSystemAction::Dictation,
        _ => FnSystemAction::Unknown,
    }
}

/// Kind of raw keyboard event seen by the listener.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RawKind {
    FlagsChanged,
    KeyDown,
}

pub const FLAG_ALPHA_SHIFT: u64 = 0x0001_0000;
pub const FLAG_SHIFT: u64 = 0x0002_0000;
pub const FLAG_CONTROL: u64 = 0x0004_0000;
pub const FLAG_ALTERNATE: u64 = 0x0008_0000;
pub const FLAG_COMMAND: u64 = 0x0010_0000;
pub const FLAG_SECONDARY_FN: u64 = 0x0080_0000;
/// Device-specific bits in the low word (NX_DEVICERALTKEYMASK, NX_DEVICERCMDKEYMASK).
/// The generic Alternate/Command masks cannot tell left from right.
pub const FLAG_RIGHT_OPTION_DEVICE: u64 = 0x0000_0040;
pub const FLAG_RIGHT_COMMAND_DEVICE: u64 = 0x0000_0010;

/// Maps a raw event to a `KeyEvent` for the configured hold key.
///
/// Modifier keys arrive as `FlagsChanged`; the keycode says which key and the
/// flag mask says whether it is now down. Any `KeyDown`, or another modifier
/// going down, counts as `OtherKeyDown`. Arrow keys set the Fn flag on their
/// `KeyDown` but send no Fn `FlagsChanged`, so they land in `OtherKeyDown`.
pub fn classify(key: HoldKey, kind: RawKind, keycode: i64, flags: u64) -> Option<KeyEvent> {
    if kind == RawKind::KeyDown {
        return Some(KeyEvent::OtherKeyDown);
    }
    let hold_code = hold_keycode(key);
    let mask = modifier_mask(keycode)?;
    if keycode == hold_code {
        // The hold key is judged by its own bit so a held left twin does not
        // mask its release.
        let down = flags & hold_mask(key) != 0;
        Some(if down { KeyEvent::HoldDown } else { KeyEvent::HoldUp })
    } else if flags & mask != 0 {
        Some(KeyEvent::OtherKeyDown)
    } else {
        None
    }
}

/// Virtual keycode of a hold key.
fn hold_keycode(key: HoldKey) -> i64 {
    match key {
        HoldKey::Fn => 63,
        HoldKey::RightOption => 61,
        HoldKey::RightCommand => 54,
    }
}

/// Flag bit that is set only while the hold key itself is down.
fn hold_mask(key: HoldKey) -> u64 {
    match key {
        HoldKey::Fn => FLAG_SECONDARY_FN,
        HoldKey::RightOption => FLAG_RIGHT_OPTION_DEVICE,
        HoldKey::RightCommand => FLAG_RIGHT_COMMAND_DEVICE,
    }
}

/// Flag mask reported by `FlagsChanged` for each modifier keycode.
fn modifier_mask(keycode: i64) -> Option<u64> {
    match keycode {
        63 => Some(FLAG_SECONDARY_FN),
        58 | 61 => Some(FLAG_ALTERNATE),
        54 | 55 => Some(FLAG_COMMAND),
        56 | 60 => Some(FLAG_SHIFT),
        59 | 62 => Some(FLAG_CONTROL),
        57 => Some(FLAG_ALPHA_SHIFT),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyEvent::*;

    #[test]
    fn default_key_is_fn() {
        assert_eq!(HoldKey::default(), HoldKey::Fn);
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn begin(window: &str, down_at: Instant) -> HoldAction {
        HoldAction::Begin { window: window.into(), down_at }
    }

    fn main() -> Option<String> {
        Some("main".into())
    }

    #[test]
    fn arm_delay_is_150ms() {
        assert_eq!(ARM_DELAY, ms(150));
    }

    #[test]
    fn a_tap_under_the_arm_delay_begins_nothing() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        assert_eq!(d.on_key(HoldDown, main(), t0), HoldAction::None);
        assert_eq!(d.deadline(), Some(t0 + ARM_DELAY));
        assert_eq!(d.on_time(t0 + ms(100)), HoldAction::None);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(149)), HoldAction::None);
        assert_eq!(d.deadline(), None);
        assert_eq!(d.on_time(t0 + ms(500)), HoldAction::None);
    }

    #[test]
    fn another_key_within_the_arm_delay_begins_nothing() {
        // Fn+arrow, Fn+Delete: the microphone never opens.
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, main(), t0);
        assert_eq!(d.on_key(OtherKeyDown, None, t0 + ms(80)), HoldAction::None);
        assert_eq!(d.deadline(), None);
        assert_eq!(d.on_time(t0 + ms(400)), HoldAction::None);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(500)), HoldAction::None);
    }

    #[test]
    fn held_past_the_arm_delay_begins_from_key_down() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, Some("task-2".into()), t0);
        assert_eq!(d.on_time(t0 + ms(149)), HoldAction::None);
        assert_eq!(d.on_time(t0 + ms(150)), begin("task-2", t0));
        assert_eq!(d.deadline(), None);
        assert_eq!(d.on_time(t0 + ms(300)), HoldAction::None);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(900)), HoldAction::End);
    }

    #[test]
    fn release_at_200ms_begins_then_ends() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, main(), t0);
        // The release is the first thing seen after the deadline.
        assert_eq!(d.on_time(t0 + ms(200)), begin("main", t0));
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(200)), HoldAction::End);
    }

    #[test]
    fn another_key_after_arming_cancels() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, main(), t0);
        assert_eq!(d.on_time(t0 + ms(150)), begin("main", t0));
        assert_eq!(d.on_key(OtherKeyDown, None, t0 + ms(400)), HoldAction::Cancel);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(500)), HoldAction::None);
        // A fresh hold works again afterwards.
        d.on_key(HoldDown, main(), t0 + ms(1000));
        assert_eq!(d.on_time(t0 + ms(1150)), begin("main", t0 + ms(1000)));
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(1600)), HoldAction::End);
    }

    #[test]
    fn down_with_no_focused_window_does_nothing() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        assert_eq!(d.on_key(HoldDown, None, t0), HoldAction::None);
        assert_eq!(d.deadline(), None);
        assert_eq!(d.on_time(t0 + ms(500)), HoldAction::None);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(600)), HoldAction::None);
    }

    #[test]
    fn release_after_losing_focus_still_ends() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, main(), t0);
        d.on_time(t0 + ms(150));
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(800)), HoldAction::End);
    }

    #[test]
    fn other_key_without_hold_does_nothing() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on_key(OtherKeyDown, main(), Instant::now()), HoldAction::None);
    }

    #[test]
    fn repeated_down_keeps_the_first_key_down() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, main(), t0);
        assert_eq!(d.on_key(HoldDown, Some("other".into()), t0 + ms(100)), HoldAction::None);
        assert_eq!(d.on_time(t0 + ms(150)), begin("main", t0));
        assert_eq!(d.on_key(HoldDown, main(), t0 + ms(200)), HoldAction::None);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(500)), HoldAction::End);
    }

    #[test]
    fn a_closed_window_drops_its_pending_arm_only() {
        let t0 = Instant::now();
        let mut d = HoldDetector::new();
        d.on_key(HoldDown, Some("task-1".into()), t0);
        d.forget_window("main");
        assert_eq!(d.deadline(), Some(t0 + ARM_DELAY));
        d.forget_window("task-1");
        assert_eq!(d.deadline(), None);
        assert_eq!(d.on_time(t0 + ms(400)), HoldAction::None);
        assert_eq!(d.on_key(HoldUp, None, t0 + ms(500)), HoldAction::None);
    }

    #[test]
    fn the_gate_passes_other_keys_only_while_the_hold_key_is_down() {
        let g = KeyGate::new();
        // Ordinary typing sends nothing.
        assert!(!g.pass(OtherKeyDown));
        assert!(!g.pass(OtherKeyDown));
        // The hold key always passes, and opens the gate at once.
        assert!(g.pass(HoldDown));
        assert!(g.pass(OtherKeyDown));
        assert!(g.pass(HoldDown));
        assert!(g.pass(HoldUp));
        assert!(!g.pass(OtherKeyDown));
        // A release with the gate closed still passes.
        assert!(g.pass(HoldUp));
    }

    #[test]
    fn fn_action_maps_the_globe_key_setting() {
        assert_eq!(fn_action_from_pref(Some(0)), FnSystemAction::None);
        assert_eq!(fn_action_from_pref(Some(1)), FnSystemAction::InputSource);
        assert_eq!(fn_action_from_pref(Some(2)), FnSystemAction::Emoji);
        assert_eq!(fn_action_from_pref(Some(3)), FnSystemAction::Dictation);
        assert_eq!(fn_action_from_pref(Some(4)), FnSystemAction::Unknown);
        assert_eq!(fn_action_from_pref(Some(-1)), FnSystemAction::Unknown);
        assert_eq!(fn_action_from_pref(None), FnSystemAction::Unknown);
        let names: Vec<_> = [
            FnSystemAction::None,
            FnSystemAction::InputSource,
            FnSystemAction::Emoji,
            FnSystemAction::Dictation,
            FnSystemAction::Unknown,
        ]
        .iter()
        .map(|a| serde_json::to_value(a).unwrap())
        .collect();
        assert_eq!(names, ["none", "input-source", "emoji", "dictation", "unknown"]);
    }

    #[test]
    fn classify_fn_down_and_up() {
        let k = HoldKey::Fn;
        assert_eq!(classify(k, RawKind::FlagsChanged, 63, FLAG_SECONDARY_FN), Some(HoldDown));
        assert_eq!(classify(k, RawKind::FlagsChanged, 63, 0), Some(HoldUp));
    }

    #[test]
    fn classify_right_option_and_command() {
        assert_eq!(
            classify(HoldKey::RightOption, RawKind::FlagsChanged, 61, FLAG_ALTERNATE | FLAG_RIGHT_OPTION_DEVICE),
            Some(HoldDown)
        );
        assert_eq!(classify(HoldKey::RightOption, RawKind::FlagsChanged, 61, 0), Some(HoldUp));
        assert_eq!(
            classify(HoldKey::RightCommand, RawKind::FlagsChanged, 54, FLAG_COMMAND | FLAG_RIGHT_COMMAND_DEVICE),
            Some(HoldDown)
        );
        assert_eq!(classify(HoldKey::RightCommand, RawKind::FlagsChanged, 54, 0), Some(HoldUp));
    }

    #[test]
    fn right_option_release_with_left_option_held_is_hold_up() {
        assert_eq!(
            classify(HoldKey::RightOption, RawKind::FlagsChanged, 61, FLAG_ALTERNATE | 0x20),
            Some(HoldUp)
        );
    }

    #[test]
    fn right_option_press_sets_device_bit() {
        assert_eq!(
            classify(HoldKey::RightOption, RawKind::FlagsChanged, 61, FLAG_ALTERNATE | 0x40),
            Some(HoldDown)
        );
    }

    #[test]
    fn right_command_release_with_left_command_held_is_hold_up() {
        assert_eq!(
            classify(HoldKey::RightCommand, RawKind::FlagsChanged, 54, FLAG_COMMAND | 0x08),
            Some(HoldUp)
        );
    }

    #[test]
    fn right_command_press_sets_device_bit() {
        assert_eq!(
            classify(HoldKey::RightCommand, RawKind::FlagsChanged, 54, FLAG_COMMAND | 0x10),
            Some(HoldDown)
        );
    }

    #[test]
    fn classify_key_down_is_other() {
        assert_eq!(classify(HoldKey::Fn, RawKind::KeyDown, 0, 0), Some(OtherKeyDown));
    }

    #[test]
    fn classify_arrow_with_fn_flag_is_other() {
        // Arrow keys set the Fn flag on keyDown but send no flagsChanged 63.
        assert_eq!(
            classify(HoldKey::Fn, RawKind::KeyDown, 123, FLAG_SECONDARY_FN),
            Some(OtherKeyDown)
        );
    }

    #[test]
    fn classify_other_modifier_down_is_other() {
        // Left shift pressed while Fn is the hold key.
        assert_eq!(
            classify(HoldKey::Fn, RawKind::FlagsChanged, 56, FLAG_SHIFT),
            Some(OtherKeyDown)
        );
        // Left command (55) is not the Right Command hold key.
        assert_eq!(
            classify(HoldKey::RightCommand, RawKind::FlagsChanged, 55, FLAG_COMMAND),
            Some(OtherKeyDown)
        );
    }

    #[test]
    fn classify_other_modifier_up_is_ignored() {
        assert_eq!(classify(HoldKey::Fn, RawKind::FlagsChanged, 56, 0), None);
    }

    #[test]
    fn classify_unknown_flags_changed_keycode_is_ignored() {
        assert_eq!(classify(HoldKey::Fn, RawKind::FlagsChanged, 200, FLAG_SHIFT), None);
    }
}
