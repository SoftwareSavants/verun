//! Microphone permission (TCC) through AVFoundation's `AVCaptureDevice`.

use std::ffi::CStr;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};

use super::service::MicPermission;

// Links AVFoundation so the `AVCaptureDevice` class is registered at runtime.
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

/// The value of `AVMediaTypeAudio`.
const MEDIA_TYPE_AUDIO: &CStr = c"soun";

/// Maps `AVAuthorizationStatus` to a permission.
pub fn from_status(raw: isize) -> MicPermission {
    match raw {
        3 => MicPermission::Granted,
        1 | 2 => MicPermission::Denied,
        _ => MicPermission::Undetermined,
    }
}

fn device_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"AVCaptureDevice")
}

/// An NSString for `AVMediaTypeAudio`. Call inside an autorelease pool.
fn media_type() -> Option<Retained<AnyObject>> {
    let cls = AnyClass::get(c"NSString")?;
    // SAFETY: `+stringWithUTF8String:` takes a NUL-terminated UTF-8 C string
    // (a static here) and returns an NSString or nil.
    unsafe { msg_send![cls, stringWithUTF8String: MEDIA_TYPE_AUDIO.as_ptr()] }
}

/// Current permission. Never prompts.
pub fn microphone_permission() -> MicPermission {
    autoreleasepool(|_| {
        let (Some(cls), Some(media)) = (device_class(), media_type()) else {
            return MicPermission::Undetermined;
        };
        // SAFETY: `+authorizationStatusForMediaType:` takes an NSString media
        // type and returns an NSInteger (`AVAuthorizationStatus`).
        let raw: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
        from_status(raw)
    })
}

/// Shows the system prompt when the permission is undetermined and resolves
/// with the user's answer; otherwise returns the current permission.
pub async fn request_microphone() -> MicPermission {
    let current = microphone_permission();
    if current != MicPermission::Undetermined {
        return current;
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    // The block is not Send, so it is created and released before the await.
    let asked = {
        let tx = Mutex::new(Some(tx));
        let handler = RcBlock::new(move |granted: Bool| {
            if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = tx.send(granted.as_bool());
            }
        });
        autoreleasepool(|_| {
            let (Some(cls), Some(media)) = (device_class(), media_type()) else {
                return false;
            };
            // SAFETY: `+requestAccessForMediaType:completionHandler:` takes an
            // NSString media type and a `void (^)(BOOL)` block, which matches
            // `handler`'s signature; AVFoundation copies the block before
            // returning, so releasing our reference afterwards is fine.
            unsafe {
                let _: () = msg_send![
                    cls,
                    requestAccessForMediaType: &*media,
                    completionHandler: &*handler
                ];
            }
            true
        })
    };
    if !asked {
        return MicPermission::Undetermined;
    }
    match rx.await {
        Ok(true) => MicPermission::Granted,
        Ok(false) => MicPermission::Denied,
        Err(_) => microphone_permission(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_authorization_status() {
        assert_eq!(from_status(0), MicPermission::Undetermined);
        assert_eq!(from_status(1), MicPermission::Denied);
        assert_eq!(from_status(2), MicPermission::Denied);
        assert_eq!(from_status(3), MicPermission::Granted);
    }

    #[test]
    fn reads_the_status_without_prompting() {
        // AVFoundation is linked and the class resolves; any answer is valid.
        assert!(device_class().is_some());
        let _ = microphone_permission();
    }
}
