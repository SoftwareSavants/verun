//! Clipboard reads for paste targets that need more than plain text: the
//! terminal (Cmd+V of a screenshot or a Finder-copied file) and the chat
//! composer (pasted documents become @-mentions). WKWebView only exposes
//! file *contents* to JS, never paths, so both go through here.

use serde::{Deserialize, Serialize};

// Only the macOS probe constructs the rich variants outside tests.
/// What a paste should insert.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipboardPaste {
    /// File URLs on the pasteboard (e.g. Cmd+C in Finder).
    Files {
        paths: Vec<String>,
    },
    /// Image bytes saved to a temp PNG so agents can read it by path.
    Image {
        path: String,
    },
    Text {
        text: String,
    },
}

/// Raw pasteboard snapshot produced by the platform probe.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardProbe {
    #[serde(default)]
    pub files: Vec<String>,
    /// Set when image data was written to disk.
    #[serde(default)]
    pub image_path: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// Pick the paste payload. File URLs win (Finder puts the filename in the
/// text flavor too). Real text beats an image so copying cells from a
/// spreadsheet (which also carries a PNG preview) still pastes text — unless
/// the text is just a URL, which is what browsers add next to a copied image.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn decide(probe: ClipboardProbe) -> ClipboardPaste {
    if !probe.files.is_empty() {
        return ClipboardPaste::Files { paths: probe.files };
    }
    let text = probe.text.unwrap_or_default();
    if let Some(path) = probe.image_path {
        if is_blank_or_single_url(&text) {
            return ClipboardPaste::Image { path };
        }
    }
    ClipboardPaste::Text { text }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_blank_or_single_url(text: &str) -> bool {
    let t = text.trim();
    t.is_empty()
        || (!t.contains(char::is_whitespace)
            && (t.starts_with("http://") || t.starts_with("https://")))
}

/// Read file URLs, the string flavor and any image (PNG, or TIFF converted to
/// PNG, written to `out`) from `pb`, in-process. Spawning `osascript` for this
/// cost 100-300 ms per paste, more under load.
#[cfg(target_os = "macos")]
pub(crate) fn probe_pasteboard(
    pb: &objc2_app_kit::NSPasteboard,
    out: &std::path::Path,
) -> ClipboardProbe {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboardTypePNG, NSPasteboardTypeString,
        NSPasteboardTypeTIFF, NSPasteboardURLReadingFileURLsOnlyKey,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSURL};

    autoreleasepool(|_| {
        let mut res = ClipboardProbe::default();
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let yes = NSNumber::new_bool(true);
        let options: objc2::rc::Retained<NSDictionary<_, AnyObject>> = NSDictionary::from_slices(
            &[unsafe { NSPasteboardURLReadingFileURLsOnlyKey }],
            &[&*yes as &AnyObject],
        );
        if let Some(urls) = unsafe { pb.readObjectsForClasses_options(&classes, Some(&options)) } {
            for obj in urls.iter() {
                if let Ok(url) = obj.downcast::<NSURL>() {
                    if let Some(path) = url.path() {
                        res.files.push(path.to_string());
                    }
                }
            }
        }
        res.text = pb
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|s| s.to_string());
        if res.files.is_empty() {
            let png = pb.dataForType(unsafe { NSPasteboardTypePNG }).or_else(|| {
                let tiff = pb.dataForType(unsafe { NSPasteboardTypeTIFF })?;
                let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
                unsafe {
                    rep.representationUsingType_properties(
                        NSBitmapImageFileType::PNG,
                        &NSDictionary::new(),
                    )
                }
            });
            if let Some(data) = png {
                if std::fs::write(out, data.to_vec()).is_ok() {
                    res.image_path = Some(out.to_string_lossy().into_owned());
                }
            }
        }
        res
    })
}

#[cfg(target_os = "macos")]
async fn probe_macos() -> Result<ClipboardProbe, String> {
    let dir = std::env::temp_dir().join("verun-paste");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create paste dir: {e}"))?;
    let out = dir.join(format!("paste-{}.png", uuid::Uuid::new_v4()));
    tokio::task::spawn_blocking(move || {
        probe_pasteboard(&objc2_app_kit::NSPasteboard::generalPasteboard(), &out)
    })
    .await
    .map_err(|e| format!("Clipboard read failed: {e}"))
}

/// Read the clipboard as a paste payload. Falls back to plain text when the
/// rich probe is unavailable (non-macOS, or osascript failed).
pub async fn read_paste() -> Result<ClipboardPaste, String> {
    #[cfg(target_os = "macos")]
    if let Ok(probe) = probe_macos().await {
        let written = probe.image_path.clone();
        let paste = decide(probe);
        if let Some(path) = written {
            if !matches!(&paste, ClipboardPaste::Image { path: p } if *p == path) {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        return Ok(paste);
    }
    let text = crate::ipc::read_clipboard().await?;
    Ok(ClipboardPaste::Text { text })
}

/// Mime type for image files the composer attaches inline (matches the
/// frontend's SUPPORTED_IMAGE_TYPES). `None` means "mention it instead".
pub fn image_mime_for_path(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_mime_by_extension() {
        assert_eq!(image_mime_for_path("/a/b.PNG"), Some("image/png"));
        assert_eq!(image_mime_for_path("/a/b.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_path("/a/b.jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_path("/a/b.gif"), Some("image/gif"));
        assert_eq!(image_mime_for_path("/a/b.webp"), Some("image/webp"));
        assert_eq!(image_mime_for_path("/a/b.pdf"), None);
        assert_eq!(image_mime_for_path("/a/png"), None);
    }

    fn probe(files: &[&str], image: Option<&str>, text: Option<&str>) -> ClipboardProbe {
        ClipboardProbe {
            files: files.iter().map(|s| s.to_string()).collect(),
            image_path: image.map(String::from),
            text: text.map(String::from),
        }
    }

    #[test]
    fn finder_files_win_over_filename_text() {
        let p = probe(
            &["/Users/me/a b.pdf", "/Users/me/c.png"],
            Some("/tmp/x.png"),
            Some("a b.pdf"),
        );
        assert_eq!(
            decide(p),
            ClipboardPaste::Files {
                paths: vec!["/Users/me/a b.pdf".into(), "/Users/me/c.png".into()]
            }
        );
    }

    #[test]
    fn screenshot_without_text_is_image() {
        assert_eq!(
            decide(probe(&[], Some("/tmp/x.png"), None)),
            ClipboardPaste::Image {
                path: "/tmp/x.png".into()
            }
        );
        assert_eq!(
            decide(probe(&[], Some("/tmp/x.png"), Some(""))),
            ClipboardPaste::Image {
                path: "/tmp/x.png".into()
            }
        );
    }

    #[test]
    fn browser_image_with_url_text_is_image() {
        assert_eq!(
            decide(probe(
                &[],
                Some("/tmp/x.png"),
                Some("https://example.com/cat.png\n")
            )),
            ClipboardPaste::Image {
                path: "/tmp/x.png".into()
            }
        );
    }

    #[test]
    fn spreadsheet_text_with_preview_image_is_text() {
        assert_eq!(
            decide(probe(&[], Some("/tmp/x.png"), Some("a\tb\n1\t2"))),
            ClipboardPaste::Text {
                text: "a\tb\n1\t2".into()
            }
        );
    }

    #[test]
    fn plain_text_and_empty_clipboard() {
        assert_eq!(
            decide(probe(&[], None, Some("hi"))),
            ClipboardPaste::Text { text: "hi".into() }
        );
        assert_eq!(
            decide(probe(&[], None, None)),
            ClipboardPaste::Text {
                text: String::new()
            }
        );
    }

    #[test]
    fn probe_parses_from_json() {
        let p: ClipboardProbe =
            serde_json::from_str(r#"{"files":["/a"],"imagePath":null,"text":"a"}"#).unwrap();
        assert_eq!(p.files, vec!["/a".to_string()]);
        assert!(p.image_path.is_none());
    }

    /// The probe reads a pasteboard in-process. These use a private pasteboard,
    /// never the user's clipboard.
    #[cfg(target_os = "macos")]
    mod native {
        use super::super::probe_pasteboard;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
        };
        use objc2_foundation::{NSData, NSString};

        // 1x1 PNG.
        const PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99,
            0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];

        fn board() -> objc2::rc::Retained<NSPasteboard> {
            let pb = NSPasteboard::pasteboardWithUniqueName();
            pb.clearContents();
            pb
        }

        #[test]
        fn text_is_read_without_writing_an_image() {
            let pb = board();
            pb.setString_forType(&NSString::from_str("héllo\nworld"), unsafe {
                NSPasteboardTypeString
            });
            let dir = tempfile::tempdir().unwrap();
            let out = dir.path().join("p.png");
            let probe = probe_pasteboard(&pb, &out);
            assert_eq!(probe.text.as_deref(), Some("héllo\nworld"));
            assert!(probe.files.is_empty());
            assert!(probe.image_path.is_none());
            assert!(!out.exists());
        }

        #[test]
        fn a_png_is_written_where_asked() {
            let pb = board();
            pb.setData_forType(Some(&NSData::with_bytes(PNG)), unsafe {
                NSPasteboardTypePNG
            });
            let dir = tempfile::tempdir().unwrap();
            let out = dir.path().join("p.png");
            let probe = probe_pasteboard(&pb, &out);
            assert_eq!(probe.image_path.as_deref(), Some(out.to_str().unwrap()));
            assert_eq!(std::fs::read(&out).unwrap(), PNG);
        }

        #[test]
        fn a_tiff_screenshot_is_converted_to_png() {
            use objc2_app_kit::NSBitmapImageRep;
            let png = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(PNG)).unwrap();
            let tiff = png.TIFFRepresentation().unwrap();
            let pb = board();
            pb.setData_forType(Some(&tiff), unsafe { NSPasteboardTypeTIFF });
            let dir = tempfile::tempdir().unwrap();
            let out = dir.path().join("p.png");
            let probe = probe_pasteboard(&pb, &out);
            assert!(probe.image_path.is_some());
            assert_eq!(&std::fs::read(&out).unwrap()[..8], &PNG[..8]);
        }

        #[test]
        fn finder_files_come_back_as_paths() {
            use objc2_foundation::{NSArray, NSURL};
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("a b.txt");
            std::fs::write(&file, "x").unwrap();
            let url = NSURL::fileURLWithPath(&NSString::from_str(file.to_str().unwrap()));
            let pb = board();
            let writer: objc2::rc::Retained<
                objc2::runtime::ProtocolObject<dyn objc2_app_kit::NSPasteboardWriting>,
            > = objc2::runtime::ProtocolObject::from_retained(url);
            assert!(pb.writeObjects(&NSArray::from_retained_slice(&[writer])));
            let probe = probe_pasteboard(&pb, &dir.path().join("p.png"));
            let real = std::fs::canonicalize(&file).unwrap();
            assert_eq!(
                probe
                    .files
                    .iter()
                    .map(|p| std::fs::canonicalize(p).unwrap())
                    .collect::<Vec<_>>(),
                vec![real]
            );
        }
    }
}
