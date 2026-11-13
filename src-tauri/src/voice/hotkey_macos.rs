//! Global hold-key listener for voice dictation: a listen-only CGEventTap on
//! its own thread. It never swallows or modifies events. Needs the
//! Accessibility permission.

use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::propertylist::{CFPropertyList, CFPropertyListRef};
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopRunResult};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    CallbackResult, EventField,
};

use super::hold::{classify, fn_action_from_pref, FnSystemAction, HoldKey, KeyEvent, KeyGate, RawKind};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFPreferencesCopyAppValue(key: CFStringRef, application_id: CFStringRef) -> CFPropertyListRef;
}

/// What macOS does on Fn (Keyboard settings, "Press Globe key to"): the
/// `AppleFnUsageType` user default of `com.apple.HIToolbox`.
pub fn fn_system_action() -> FnSystemAction {
    let key = CFString::from_static_string("AppleFnUsageType");
    let domain = CFString::from_static_string("com.apple.HIToolbox");
    // SAFETY: both arguments are valid CFStrings that outlive the call. The
    // result follows the Create rule (we own it) and may be NULL.
    let value = unsafe { CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), domain.as_concrete_TypeRef()) };
    if value.is_null() {
        return fn_action_from_pref(None);
    }
    // SAFETY: `value` is non-NULL and owned by us (Create rule); wrapping it
    // hands that ownership to `CFPropertyList`, which releases it on drop.
    let value = unsafe { CFPropertyList::wrap_under_create_rule(value) };
    fn_action_from_pref(value.downcast::<CFNumber>().and_then(|n| n.to_i64()))
}

/// Whether an Accessibility check may show the system prompt. macOS lists an
/// app in Privacy & Security > Accessibility only once it has asked with the
/// prompt (or the user added it by hand), so the button that sends the user
/// there asks; nothing else ever does.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AxPrompt {
    Never,
    /// Only from a user's click. Shows the prompt if Verun is not trusted yet.
    IfUntrusted,
}

/// The options dictionary for `AXIsProcessTrustedWithOptions`.
fn trust_options(prompt: AxPrompt) -> CFDictionary<CFString, CFBoolean> {
    // SAFETY: a constant CFString exported by ApplicationServices.
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let value = if prompt == AxPrompt::IfUntrusted {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    CFDictionary::from_CFType_pairs(&[(key, value)])
}

fn ax_trusted(prompt: AxPrompt) -> bool {
    let options = trust_options(prompt);
    // SAFETY: `options` is a valid CFDictionary that outlives the call.
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0 }
}

/// Whether Verun may observe global key events. Never prompts.
pub fn accessibility_granted() -> bool {
    ax_trusted(AxPrompt::Never)
}

/// Call only from the user's click on the Accessibility button: asks macOS
/// (which adds Verun to the Accessibility list, prompting if it is not
/// trusted yet), then opens that pane of System Settings.
pub fn open_accessibility_settings() {
    ax_trusted(AxPrompt::IfUntrusted);
    match std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn()
    {
        Ok(mut child) => {
            // Reap the child so it does not linger as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => eprintln!("[verun][voice] could not open Accessibility settings: {e}"),
    }
}

/// `on_event` runs on the tap thread for the hold key's events, and for other
/// keys only while the hold key is down (see `KeyGate`), so it must not block or panic (a panic is caught and logged, and the event is
/// dropped). Dropping the listener blocks up to about 500 ms while the tap
/// thread exits: drop it off the async runtime (e.g. `spawn_blocking`) and
/// never from inside `on_event`.
///
/// Dropping it stops the tap's run loop, joins the thread and removes the tap.
pub struct HotkeyListener {
    run_loop: CFRunLoop,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl HotkeyListener {
    /// `None` without Accessibility permission or if the tap cannot be created.
    pub fn start(
        key: HoldKey,
        on_event: impl Fn(KeyEvent) + Send + 'static,
    ) -> Option<HotkeyListener> {
        if !accessibility_granted() {
            return None;
        }
        let (tx, rx) = mpsc::channel::<Option<CFRunLoop>>();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("voice-hotkey".into())
            .spawn(move || run_tap(key, on_event, tx, thread_stop))
            .ok()?;
        match rx.recv() {
            Ok(Some(run_loop)) => Some(HotkeyListener {
                run_loop,
                stop,
                thread: Some(thread),
            }),
            _ => {
                let _ = thread.join();
                None
            }
        }
    }
}

impl Drop for HotkeyListener {
    fn drop(&mut self) {
        // CFRunLoopStop is thread-safe. The tap is dropped (and invalidated)
        // by the thread once its run loop returns. The flag covers a stop that
        // lands before the loop is running (a no-op for CFRunLoopStop).
        self.stop.store(true, Ordering::Release);
        self.run_loop.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Thread body: create the tap, report the run loop (or failure), then run.
fn run_tap(
    key: HoldKey,
    on_event: impl Fn(KeyEvent) + Send + 'static,
    ready: mpsc::Sender<Option<CFRunLoop>>,
    stop: Arc<AtomicBool>,
) {
    // The callback re-enables the tap when macOS disables it, so it needs the
    // mach port, which only exists after the tap is created. Stored as a raw
    // address, filled in below.
    let port = Arc::new(AtomicUsize::new(0));
    let cb_port = Arc::clone(&port);
    // Only the tap thread touches it.
    let gate = KeyGate::new();
    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
        move |_proxy, kind, event| {
            let raw = match kind {
                CGEventType::FlagsChanged => RawKind::FlagsChanged,
                CGEventType::KeyDown => RawKind::KeyDown,
                CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                    let p = cb_port.load(Ordering::Acquire);
                    if p != 0 {
                        // SAFETY: `p` is the live tap's mach port; the tap
                        // outlives the run loop that invokes this callback.
                        unsafe { CGEventTapEnable(p as *mut c_void, true) };
                    }
                    return CallbackResult::Keep;
                }
                _ => return CallbackResult::Keep,
            };
            let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
            let ev = classify(key, raw, keycode, event.get_flags().bits()).filter(|ev| gate.pass(*ev));
            if let Some(ev) = ev {
                // A panic must not unwind across the extern "C" tap callback.
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_event(ev))).is_err()
                {
                    eprintln!("[verun][voice] hotkey on_event panicked; event dropped");
                }
            }
            CallbackResult::Keep
        },
    );
    let Ok(tap) = tap else {
        let _ = ready.send(None);
        return;
    };
    let Ok(source) = tap.mach_port().create_runloop_source(0) else {
        let _ = ready.send(None);
        return;
    };
    port.store(tap.mach_port().as_concrete_TypeRef() as usize, Ordering::Release);
    let run_loop = CFRunLoop::get_current();
    // SAFETY: kCFRunLoopCommonModes is a constant CFString exported by CoreFoundation.
    run_loop.add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();
    let _ = ready.send(Some(run_loop));
    // Bounded slices so a stop that raced ahead of the loop is still noticed.
    while !stop.load(Ordering::Acquire) {
        // SAFETY: kCFRunLoopDefaultMode is a constant CFString exported by CoreFoundation.
        let mode = unsafe { kCFRunLoopDefaultMode };
        let result = CFRunLoop::run_in_mode(mode, std::time::Duration::from_millis(500), false);
        // Finished means no sources left (port invalidated): stop, don't spin.
        if matches!(result, CFRunLoopRunResult::Finished) {
            break;
        }
    }
    // `tap` drops below, invalidating the port.
    drop(source);
    drop(tap);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt_value(prompt: AxPrompt) -> Option<bool> {
        // SAFETY: a constant CFString exported by ApplicationServices.
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        trust_options(prompt).find(&key).map(|v| bool::from(v.clone()))
    }

    #[test]
    fn only_the_click_path_asks_with_the_prompt() {
        assert_eq!(prompt_value(AxPrompt::Never), Some(false));
        assert_eq!(prompt_value(AxPrompt::IfUntrusted), Some(true));
    }
}
