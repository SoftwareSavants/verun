use crate::voice::catalog::{spec, ModelId, ModelSpec};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct ModelStatus {
    pub id: ModelId,
    pub display_name: &'static str,
    pub installed: bool,
    pub bytes: u64,
}

#[derive(Debug, PartialEq)]
pub enum DownloadError {
    Network(String),
    Checksum { file: String },
    Io(String),
}

pub fn models_dir(app_data: &Path) -> PathBuf {
    app_data.join("voice-models")
}

fn total_bytes(spec: &ModelSpec) -> u64 {
    spec.files.iter().map(|f| f.bytes).sum()
}

/// Every file present with exactly the catalog size (no hashing here).
pub fn is_installed_spec(dir: &Path, spec: &ModelSpec) -> bool {
    spec.files.iter().all(|f| {
        std::fs::metadata(dir.join(f.rel_path)).is_ok_and(|m| m.is_file() && m.len() == f.bytes)
    })
}

pub fn is_installed(dir: &Path, id: ModelId) -> bool {
    is_installed_spec(dir, spec(id))
}

pub fn status(dir: &Path) -> Vec<ModelStatus> {
    [ModelId::WhisperTurbo]
        .into_iter()
        .map(|id| {
            let s = spec(id);
            ModelStatus {
                id,
                display_name: s.display_name,
                installed: is_installed_spec(dir, s),
                bytes: total_bytes(s),
            }
        })
        .collect()
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn delete(dir: &Path, id: ModelId) -> std::io::Result<()> {
    for f in spec(id).files {
        remove_if_exists(&dir.join(f.rel_path))?;
        remove_if_exists(&dir.join(format!("{}.part", f.rel_path)))?;
    }
    Ok(())
}

pub trait Fetch: Send + Sync {
    fn get(
        &self,
        url: &str,
        sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
    ) -> std::io::Result<()>;
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Downloads one file to `<file>.part`, verifies size and SHA-256, renames into place.
/// `base` is the number of bytes already received for earlier files.
fn download_file(
    dir: &Path,
    file: &crate::voice::catalog::ModelFile,
    fetch: &dyn Fetch,
    base: u64,
    total: u64,
    on_progress: &dyn Fn(u64, u64),
) -> Result<(), DownloadError> {
    let final_path = dir.join(file.rel_path);
    let part_path = dir.join(format!("{}.part", file.rel_path));
    let io = |e: std::io::Error| DownloadError::Io(e.to_string());

    remove_if_exists(&part_path).map_err(io)?;
    let mut out = std::fs::File::create(&part_path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut write_err: Option<std::io::Error> = None;

    let fetched = fetch.get(file.url, &mut |chunk| {
        out.write_all(chunk).inspect_err(|e| {
            write_err = Some(std::io::Error::new(e.kind(), e.to_string()));
        })?;
        hasher.update(chunk);
        received += chunk.len() as u64;
        on_progress(base + received, total);
        Ok(())
    });
    drop(out);

    let result = match (fetched, write_err) {
        (_, Some(e)) => Err(DownloadError::Io(e.to_string())),
        (Err(e), None) => Err(DownloadError::Network(e.to_string())),
        (Ok(()), None) => {
            if received != file.bytes || hex(&hasher.finalize()) != file.sha256.to_lowercase() {
                Err(DownloadError::Checksum {
                    file: file.rel_path.to_string(),
                })
            } else {
                std::fs::rename(&part_path, &final_path).map_err(io)
            }
        }
    };
    if result.is_err() {
        let _ = remove_if_exists(&part_path);
    }
    result
}

pub fn download_spec(
    dir: &Path,
    spec: &ModelSpec,
    fetch: &dyn Fetch,
    on_progress: &dyn Fn(u64, u64),
) -> Result<(), DownloadError> {
    std::fs::create_dir_all(dir).map_err(|e| DownloadError::Io(e.to_string()))?;
    let total = total_bytes(spec);
    let mut base = 0;
    for file in spec.files {
        let installed = std::fs::metadata(dir.join(file.rel_path))
            .is_ok_and(|m| m.is_file() && m.len() == file.bytes);
        if installed {
            base += file.bytes;
            on_progress(base, total);
            continue;
        }
        download_file(dir, file, fetch, base, total, on_progress)?;
        base += file.bytes;
    }
    on_progress(total, total);
    Ok(())
}

pub fn download(
    dir: &Path,
    id: ModelId,
    fetch: &dyn Fetch,
    on_progress: &dyn Fn(u64, u64),
) -> Result<(), DownloadError> {
    download_spec(dir, spec(id), fetch, on_progress)
}

/// Real network fetch. Uses `reqwest::blocking`, which panics inside an async
/// runtime: only call it from a blocking thread (e.g. `spawn_blocking`).
pub struct HttpFetch;

impl Fetch for HttpFetch {
    fn get(
        &self,
        url: &str,
        sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        use std::io::Read;
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            // The blocking client's default 30s total timeout would abort a large download.
            .timeout(None)
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(std::io::Error::other)?;
        let mut resp = client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(std::io::Error::other)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = resp.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            sink(&buf[..n])?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::catalog::{ModelFile, ModelSpec};
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;

    const CONTENT: &[u8] = b"hello voice model bytes";

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn test_spec() -> &'static ModelSpec {
        let files: &'static [ModelFile] = Box::leak(Box::new([ModelFile {
            url: "https://example.test/m.bin",
            rel_path: "m.bin",
            sha256: Box::leak(hex(CONTENT).into_boxed_str()),
            bytes: CONTENT.len() as u64,
        }]));
        Box::leak(Box::new(ModelSpec {
            id: ModelId::WhisperTurbo,
            display_name: "Test",
            files,
        }))
    }

    /// Serves `body` in 5-byte chunks; if `fail_after` is set, errors once that many bytes were sent.
    struct FakeFetch {
        body: Vec<u8>,
        fail_after: Option<usize>,
    }

    impl Fetch for FakeFetch {
        fn get(
            &self,
            _url: &str,
            sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            let mut sent = 0;
            for chunk in self.body.chunks(5) {
                if let Some(limit) = self.fail_after {
                    if sent >= limit {
                        return Err(std::io::Error::other("connection reset"));
                    }
                }
                sink(chunk)?;
                sent += chunk.len();
            }
            Ok(())
        }
    }

    fn ok_fetch() -> FakeFetch {
        FakeFetch {
            body: CONTENT.to_vec(),
            fail_after: None,
        }
    }

    fn files_in(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn models_dir_is_under_app_data() {
        assert_eq!(
            models_dir(Path::new("/data")),
            PathBuf::from("/data/voice-models")
        );
    }

    #[test]
    fn not_installed_when_files_are_missing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_installed_spec(tmp.path(), test_spec()));
        assert!(!is_installed(tmp.path(), ModelId::WhisperTurbo));
    }

    #[test]
    fn not_installed_when_size_differs() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("m.bin"), b"short").unwrap();
        assert!(!is_installed_spec(tmp.path(), test_spec()));
    }

    #[test]
    fn installed_when_all_files_match_size() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("m.bin"), CONTENT).unwrap();
        assert!(is_installed_spec(tmp.path(), test_spec()));
    }

    #[test]
    fn status_lists_every_model_as_not_installed_in_an_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let st = status(tmp.path());
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].id, ModelId::WhisperTurbo);
        assert!(!st[0].installed);
        assert!(st[0].bytes > 0);
    }

    #[test]
    fn download_writes_files_and_reports_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("nested").join("voice-models");
        let calls = RefCell::new(Vec::new());
        download_spec(&dir, test_spec(), &ok_fetch(), &|r, t| {
            calls.borrow_mut().push((r, t))
        })
        .unwrap();
        let total = CONTENT.len() as u64;
        let calls = calls.into_inner();
        assert!(calls.len() > 1);
        assert!(calls.iter().all(|&(r, t)| t == total && r <= total));
        assert!(calls.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!(*calls.last().unwrap(), (total, total));
        assert!(is_installed_spec(&dir, test_spec()));
        assert_eq!(std::fs::read(dir.join("m.bin")).unwrap(), CONTENT);
        assert_eq!(files_in(&dir), vec!["m.bin".to_string()]);
    }

    #[test]
    fn checksum_mismatch_removes_the_partial_file() {
        let tmp = tempfile::tempdir().unwrap();
        let fetch = FakeFetch {
            body: b"WRONG voice model bytes".to_vec(),
            fail_after: None,
        };
        let r = download_spec(tmp.path(), test_spec(), &fetch, &|_, _| {});
        assert_eq!(
            r,
            Err(DownloadError::Checksum {
                file: "m.bin".into()
            })
        );
        assert!(files_in(tmp.path()).is_empty());
        assert!(!is_installed_spec(tmp.path(), test_spec()));
    }

    #[test]
    fn size_mismatch_is_a_checksum_error() {
        let tmp = tempfile::tempdir().unwrap();
        let fetch = FakeFetch {
            body: CONTENT[..10].to_vec(),
            fail_after: None,
        };
        let r = download_spec(tmp.path(), test_spec(), &fetch, &|_, _| {});
        assert!(matches!(r, Err(DownloadError::Checksum { .. })));
        assert!(files_in(tmp.path()).is_empty());
    }

    #[test]
    fn interrupted_download_leaves_model_uninstalled_and_retry_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let broken = FakeFetch {
            body: CONTENT.to_vec(),
            fail_after: Some(10),
        };
        let r = download_spec(tmp.path(), test_spec(), &broken, &|_, _| {});
        assert!(matches!(r, Err(DownloadError::Network(_))));
        assert!(files_in(tmp.path()).is_empty());
        assert!(!is_installed_spec(tmp.path(), test_spec()));

        download_spec(tmp.path(), test_spec(), &ok_fetch(), &|_, _| {}).unwrap();
        assert!(is_installed_spec(tmp.path(), test_spec()));
    }

    #[test]
    fn stale_part_file_is_replaced_not_resumed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("m.bin.part"), b"stale garbage").unwrap();
        download_spec(tmp.path(), test_spec(), &ok_fetch(), &|_, _| {}).unwrap();
        assert_eq!(std::fs::read(tmp.path().join("m.bin")).unwrap(), CONTENT);
        assert_eq!(files_in(tmp.path()), vec!["m.bin".to_string()]);
    }

    #[test]
    fn already_installed_file_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("m.bin"), CONTENT).unwrap();
        // A fetch that fails immediately proves the network is never touched.
        let failing = FakeFetch {
            body: CONTENT.to_vec(),
            fail_after: Some(0),
        };
        let calls = RefCell::new(Vec::new());
        download_spec(tmp.path(), test_spec(), &failing, &|r, t| {
            calls.borrow_mut().push((r, t))
        })
        .unwrap();
        let total = CONTENT.len() as u64;
        assert_eq!(*calls.borrow().last().unwrap(), (total, total));
    }

    #[test]
    fn delete_removes_the_model_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("ggml-large-v3-turbo-q5_0.bin"), b"x").unwrap();
        std::fs::write(tmp.path().join("ggml-large-v3-turbo-q5_0.bin.part"), b"x").unwrap();
        delete(tmp.path(), ModelId::WhisperTurbo).unwrap();
        assert!(files_in(tmp.path()).is_empty());
    }

    #[test]
    fn delete_of_a_missing_model_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        delete(tmp.path(), ModelId::WhisperTurbo).unwrap();
    }
}
