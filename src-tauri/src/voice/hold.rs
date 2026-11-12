//! Pure hold-to-talk key logic: turns raw key events into dictation actions.
//! Platform independent; the macOS event tap in `hotkey_macos` feeds it.

use serde::{Deserialize, Serialize};

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
    Begin,
    End,
    Cancel,
    None,
}

#[derive(Default)]
pub struct HoldDetector {
    /// The hold key is down and a dictation was begun for it.
    active: bool,
}

impl HoldDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// `verun_frontmost` only gates starting: a release always ends a hold
    /// that began, even if focus moved away meanwhile.
    pub fn on(&mut self, ev: KeyEvent, verun_frontmost: bool) -> HoldAction {
        match ev {
            KeyEvent::HoldDown if !self.active && verun_frontmost => {
                self.active = true;
                HoldAction::Begin
            }
            KeyEvent::HoldUp if self.active => {
                self.active = false;
                HoldAction::End
            }
            KeyEvent::OtherKeyDown if self.active => {
                self.active = false;
                HoldAction::Cancel
            }
            _ => HoldAction::None,
        }
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
    use HoldAction::{Begin, Cancel, End};
    use KeyEvent::*;

    #[test]
    fn default_key_is_fn() {
        assert_eq!(HoldKey::default(), HoldKey::Fn);
    }

    #[test]
    fn down_then_up_begins_and_ends() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on(HoldDown, true), Begin);
        assert_eq!(d.on(HoldUp, true), End);
    }

    #[test]
    fn down_when_verun_is_not_frontmost_does_nothing() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on(HoldDown, false), HoldAction::None);
        assert_eq!(d.on(HoldUp, false), HoldAction::None);
        assert_eq!(d.on(HoldUp, true), HoldAction::None);
    }

    #[test]
    fn release_after_losing_focus_still_ends() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on(HoldDown, true), Begin);
        assert_eq!(d.on(HoldUp, false), End);
    }

    #[test]
    fn other_key_during_hold_cancels() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on(HoldDown, true), Begin);
        assert_eq!(d.on(OtherKeyDown, true), Cancel);
        assert_eq!(d.on(HoldUp, true), HoldAction::None);
        // A fresh hold works again afterwards.
        assert_eq!(d.on(HoldDown, true), Begin);
        assert_eq!(d.on(HoldUp, true), End);
    }

    #[test]
    fn other_key_without_hold_does_nothing() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on(OtherKeyDown, true), HoldAction::None);
    }

    #[test]
    fn repeated_down_is_ignored() {
        let mut d = HoldDetector::new();
        assert_eq!(d.on(HoldDown, true), Begin);
        assert_eq!(d.on(HoldDown, true), HoldAction::None);
        assert_eq!(d.on(HoldUp, true), End);
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
