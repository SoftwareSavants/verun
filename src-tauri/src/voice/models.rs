use crate::voice::catalog::{spec, ModelFile, ModelId, ModelSpec};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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

fn file_installed(dir: &Path, file: &ModelFile) -> bool {
    std::fs::metadata(dir.join(file.rel_path)).is_ok_and(|m| m.is_file() && m.len() == file.bytes)
}

/// Every file present with exactly the catalog size (no hashing here).
pub fn is_installed_spec(dir: &Path, spec: &ModelSpec) -> bool {
    spec.files.iter().all(|f| file_installed(dir, f))
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
/// Opens a file to write a download into.
type OpenPart<'a> = &'a dyn Fn(&Path) -> std::io::Result<Box<dyn Write>>;

fn create_part(path: &Path) -> std::io::Result<Box<dyn Write>> {
    Ok(Box::new(std::fs::File::create(path)?))
}

fn download_file(
    dir: &Path,
    file: &ModelFile,
    fetch: &dyn Fetch,
    base: u64,
    total: u64,
    on_progress: &dyn Fn(u64, u64),
    open: OpenPart,
) -> Result<(), DownloadError> {
    let final_path = dir.join(file.rel_path);
    let part_path = dir.join(format!("{}.part", file.rel_path));
    let io = |e: std::io::Error| DownloadError::Io(e.to_string());

    if let Some(parent) = part_path.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    remove_if_exists(&part_path).map_err(io)?;
    let mut out = open(&part_path).map_err(io)?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    // Set when the sink aborts the transfer (write failure or oversized body).
    let mut abort: Option<DownloadError> = None;

    let fetched = fetch.get(file.url, &mut |chunk| {
        if let Err(e) = out.write_all(chunk) {
            abort = Some(DownloadError::Io(e.to_string()));
            return Err(e);
        }
        hasher.update(chunk);
        received += chunk.len() as u64;
        if received > file.bytes {
            abort = Some(DownloadError::Checksum {
                file: file.rel_path.to_string(),
            });
            return Err(std::io::Error::other("response larger than expected"));
        }
        on_progress(base + received, total);
        Ok(())
    });
    drop(out);

    let result = match (fetched, abort) {
        (_, Some(e)) => Err(e),
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
    download_spec_with(dir, spec, fetch, on_progress, &create_part)
}

/// `download_spec` writing each `.part` file through `open`.
fn download_spec_with(
    dir: &Path,
    spec: &ModelSpec,
    fetch: &dyn Fetch,
    on_progress: &dyn Fn(u64, u64),
    open: OpenPart,
) -> Result<(), DownloadError> {
    std::fs::create_dir_all(dir).map_err(|e| DownloadError::Io(e.to_string()))?;
    let total = total_bytes(spec);
    let mut base = 0;
    for file in spec.files {
        if file_installed(dir, file) {
            base += file.bytes;
            on_progress(base, total);
            continue;
        }
        download_file(dir, file, fetch, base, total, on_progress, open)?;
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

/// No bytes for this long aborts the download.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

enum Msg {
    Chunk(Vec<u8>),
    Done(std::io::Result<()>),
}

/// Feeds chunks from the reader thread to `sink`; gives up when nothing arrives for `stall`.
fn pump(
    rx: &Receiver<Msg>,
    stall: Duration,
    sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    loop {
        match rx.recv_timeout(stall) {
            Ok(Msg::Chunk(c)) => sink(&c)?,
            Ok(Msg::Done(r)) => return r,
            Err(RecvTimeoutError::Timeout) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "download stalled",
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(std::io::Error::other("download reader stopped"))
            }
        }
    }
}

/// Real network fetch. Uses `reqwest::blocking`, which panics inside an async
/// runtime: only call it from a blocking thread (e.g. `spawn_blocking`).
pub struct HttpFetch {
    client: reqwest::blocking::Client,
}

impl HttpFetch {
    pub fn new() -> Result<HttpFetch, String> {
        // reqwest is built without a bundled crypto provider; install ring (idempotent, Err means one is set).
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            // The blocking client's default 30s total timeout would abort a large download.
            .timeout(None)
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(HttpFetch { client })
    }
}

impl Fetch for HttpFetch {
    fn get(
        &self,
        url: &str,
        sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        use std::io::Read;
        let mut resp = self
            .client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(std::io::Error::other)?;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Msg>(4);
        // Blocking reads happen on a helper thread so a stalled socket cannot hang the
        // caller. On a stall the helper is left to die when the socket does; if `sink`
        // fails, dropping `rx` makes its next send fail and it exits.
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            let end = loop {
                match resp.read(&mut buf) {
                    Ok(0) => break Ok(()),
                    Ok(n) => {
                        if tx.send(Msg::Chunk(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(e) => break Err(e),
                }
            };
            let _ = tx.send(Msg::Done(end));
        });
        pump(&rx, STALL_TIMEOUT, sink)
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
    fn http_fetch_builds_without_a_network() {
        assert!(HttpFetch::new().is_ok());
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

    fn spec_of(files: &[(&'static str, &'static [u8])]) -> &'static ModelSpec {
        let files: Vec<ModelFile> = files
            .iter()
            .map(|(rel, content)| ModelFile {
                url: rel,
                rel_path: rel,
                sha256: Box::leak(hex(content).into_boxed_str()),
                bytes: content.len() as u64,
            })
            .collect();
        Box::leak(Box::new(ModelSpec {
            id: ModelId::WhisperTurbo,
            display_name: "Test",
            files: Box::leak(files.into_boxed_slice()),
        }))
    }

    /// Serves `bodies[url]`; records every requested url.
    struct UrlFetch {
        bodies: Vec<(&'static str, &'static [u8])>,
        requested: std::sync::Mutex<Vec<String>>,
    }

    impl Fetch for UrlFetch {
        fn get(
            &self,
            url: &str,
            sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
        ) -> std::io::Result<()> {
            self.requested.lock().unwrap().push(url.to_string());
            let body = self.bodies.iter().find(|(u, _)| *u == url).unwrap().1;
            for chunk in body.chunks(5) {
                sink(chunk)?;
            }
            Ok(())
        }
    }

    #[test]
    fn part_file_that_cannot_be_created_is_io() {
        let tmp = tempfile::tempdir().unwrap();
        // "sub" is a regular file, so creating "sub/m.bin.part" must fail.
        std::fs::write(tmp.path().join("sub"), b"x").unwrap();
        let spec = spec_of(&[("sub/m.bin", CONTENT)]);
        let r = download_spec(tmp.path(), spec, &ok_fetch(), &|_, _| {});
        assert!(matches!(r, Err(DownloadError::Io(_))), "{r:?}");
        assert_eq!(files_in(tmp.path()), vec!["sub".to_string()]);
    }

    /// Creates the real `.part` file but fails every write after `ok_writes`.
    struct FailingPart {
        _file: std::fs::File,
        ok_writes: usize,
    }

    impl Write for FailingPart {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.ok_writes == 0 {
                return Err(std::io::Error::other("disk full"));
            }
            self.ok_writes -= 1;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn sink_write_failure_is_io_and_leaves_no_part() {
        let tmp = tempfile::tempdir().unwrap();
        let fetch = ok_fetch();
        let opened = std::cell::Cell::new(false);
        let open = |p: &Path| -> std::io::Result<Box<dyn Write>> {
            opened.set(true);
            Ok(Box::new(FailingPart { _file: std::fs::File::create(p)?, ok_writes: 1 }))
        };
        let r = download_spec_with(tmp.path(), test_spec(), &fetch, &|_, _| {}, &open);
        assert!(opened.get());
        assert_eq!(r, Err(DownloadError::Io("disk full".into())));
        assert!(files_in(tmp.path()).is_empty(), "{:?}", files_in(tmp.path()));
    }

    #[test]
    fn rel_path_with_a_subdirectory_is_created() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = spec_of(&[("sub/m.bin", CONTENT)]);
        download_spec(tmp.path(), spec, &ok_fetch(), &|_, _| {}).unwrap();
        assert_eq!(std::fs::read(tmp.path().join("sub/m.bin")).unwrap(), CONTENT);
        assert!(files_in(&tmp.path().join("sub")) == vec!["m.bin".to_string()]);
    }

    #[test]
    fn second_file_continues_progress_after_a_skipped_first_file() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = spec_of(&[("a.bin", b"first file"), ("b.bin", b"second file!")]);
        std::fs::write(tmp.path().join("a.bin"), b"first file").unwrap();
        let fetch = UrlFetch {
            bodies: vec![("a.bin", b"first file"), ("b.bin", b"second file!")],
            requested: Default::default(),
        };
        let calls = RefCell::new(Vec::new());
        download_spec(tmp.path(), spec, &fetch, &|r, t| calls.borrow_mut().push((r, t))).unwrap();
        let calls = calls.into_inner();
        assert_eq!(*fetch.requested.lock().unwrap(), vec!["b.bin".to_string()]);
        assert_eq!(calls[0], (10, 22));
        assert!(calls.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!(*calls.last().unwrap(), (22, 22));
        assert!(is_installed_spec(tmp.path(), spec));
    }

    #[test]
    fn oversized_response_is_rejected_early() {
        struct Endless {
            sent: std::sync::atomic::AtomicUsize,
            sink_failed: std::sync::atomic::AtomicBool,
        }
        impl Fetch for Endless {
            fn get(
                &self,
                _url: &str,
                sink: &mut dyn FnMut(&[u8]) -> std::io::Result<()>,
            ) -> std::io::Result<()> {
                use std::sync::atomic::Ordering::SeqCst;
                for _ in 0..1000 {
                    if let Err(e) = sink(b"01234") {
                        self.sink_failed.store(true, SeqCst);
                        return Err(e);
                    }
                    self.sent.fetch_add(5, SeqCst);
                }
                Ok(())
            }
        }
        use std::sync::atomic::Ordering::SeqCst;
        let tmp = tempfile::tempdir().unwrap();
        let fetch = Endless {
            sent: Default::default(),
            sink_failed: Default::default(),
        };
        let r = download_spec(tmp.path(), test_spec(), &fetch, &|_, _| {});
        assert_eq!(
            r,
            Err(DownloadError::Checksum {
                file: "m.bin".into()
            })
        );
        assert!(fetch.sink_failed.load(SeqCst));
        assert!(fetch.sent.load(SeqCst) <= CONTENT.len() + 5);
        assert!(files_in(tmp.path()).is_empty());
    }

    use std::sync::mpsc::sync_channel;
    use std::time::Duration;

    fn collect(
        rx: &Receiver<Msg>,
        stall: Duration,
    ) -> (std::io::Result<()>, Vec<u8>) {
        let mut got = Vec::new();
        let r = pump(rx, stall, &mut |c| {
            got.extend_from_slice(c);
            Ok(())
        });
        (r, got)
    }

    #[test]
    fn pump_passes_chunks_in_order_then_ok() {
        let (tx, rx) = sync_channel(4);
        tx.send(Msg::Chunk(b"ab".to_vec())).unwrap();
        tx.send(Msg::Chunk(b"cd".to_vec())).unwrap();
        tx.send(Msg::Done(Ok(()))).unwrap();
        let (r, got) = collect(&rx, Duration::from_secs(5));
        assert!(r.is_ok());
        assert_eq!(got, b"abcd");
    }

    #[test]
    fn pump_times_out_when_nothing_arrives() {
        let (_tx, rx) = sync_channel::<Msg>(4);
        let (r, _) = collect(&rx, Duration::from_millis(50));
        let e = r.unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(e.to_string(), "download stalled");
    }

    #[test]
    fn pump_returns_a_sink_error() {
        let (tx, rx) = sync_channel(4);
        tx.send(Msg::Chunk(b"ab".to_vec())).unwrap();
        let r = pump(&rx, Duration::from_secs(5), &mut |_| {
            Err(std::io::Error::other("disk full"))
        });
        assert_eq!(r.unwrap_err().to_string(), "disk full");
    }

    #[test]
    fn pump_returns_a_reader_error() {
        let (tx, rx) = sync_channel(4);
        tx.send(Msg::Chunk(b"ab".to_vec())).unwrap();
        tx.send(Msg::Done(Err(std::io::Error::other("reset")))).unwrap();
        let (r, got) = collect(&rx, Duration::from_secs(5));
        assert_eq!(r.unwrap_err().to_string(), "reset");
        assert_eq!(got, b"ab");
    }
}
