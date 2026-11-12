//! Global hold-key listener for voice dictation: a listen-only CGEventTap on
//! its own thread. It never swallows or modifies events. Needs the
//! Accessibility permission.

use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;

use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    CallbackResult, EventField,
};

use super::hold::{classify, HoldKey, KeyEvent, RawKind};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
}

/// Whether Verun may observe global key events. Never prompts.
pub fn accessibility_granted() -> bool {
    // SAFETY: plain C call with no arguments or preconditions.
    unsafe { AXIsProcessTrusted() }
}

pub fn open_accessibility_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

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
            if let Some(ev) = classify(key, raw, keycode, event.get_flags().bits()) {
                on_event(ev);
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
        CFRunLoop::run_in_mode(mode, std::time::Duration::from_millis(500), false);
    }
    // `tap` drops below, invalidating the port.
    drop(source);
    drop(tap);
}
