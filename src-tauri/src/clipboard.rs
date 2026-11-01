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

/// JXA probe: dumps file URLs and the string flavor, and writes any image
/// (PNG, or TIFF converted to PNG) to `argv[0]`. Output is a `ClipboardProbe` JSON.
#[cfg(target_os = "macos")]
const MACOS_PROBE: &str = r#"
ObjC.import('AppKit');
function isSet(o) { return o !== undefined && o !== null && !(o.isNil && o.isNil()); }
function run(argv) {
  var out = argv[0];
  var pb = $.NSPasteboard.generalPasteboard;
  var res = { files: [], imagePath: null, text: null };
  var opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
  var urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), opts);
  if (isSet(urls)) {
    for (var i = 0; i < urls.count; i++) res.files.push(ObjC.unwrap(urls.objectAtIndex(i).path));
  }
  var s = pb.stringForType($.NSPasteboardTypeString);
  if (isSet(s)) res.text = ObjC.unwrap(s);
  if (res.files.length === 0) {
    var data = pb.dataForType($.NSPasteboardTypePNG);
    if (!isSet(data)) {
      var tiff = pb.dataForType($.NSPasteboardTypeTIFF);
      if (isSet(tiff)) {
        var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
        // 4 = NSBitmapImageFileTypePNG
        if (isSet(rep)) data = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
      }
    }
    if (isSet(data) && data.writeToFileAtomically(out, true)) res.imagePath = out;
  }
  return JSON.stringify(res);
}
"#;

#[cfg(target_os = "macos")]
async fn probe_macos() -> Result<ClipboardProbe, String> {
    let dir = std::env::temp_dir().join("verun-paste");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create paste dir: {e}"))?;
    let out = dir.join(format!("paste-{}.png", uuid::Uuid::new_v4()));
    let output = tokio::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", MACOS_PROBE])
        .arg(&out)
        .output()
        .await
        .map_err(|e| format!("Failed to run osascript: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    serde_json::from_slice(output.stdout.trim_ascii())
        .map_err(|e| format!("Bad clipboard probe output: {e}"))
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
}
