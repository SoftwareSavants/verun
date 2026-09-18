fn main() {
    ensure_relay_sidecar_placeholder();
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    tauri_build::build()
}

/// tauri-build's `bundle.externalBin` validation requires the sidecar file to
/// exist at cargo-build time, but the binary itself is produced by cargo — a
/// chicken-and-egg that `scripts/check.sh` / the `pnpm tauri` beforeBuild hook
/// paper over by pre-creating an empty placeholder. Bare `cargo check/test/
/// clippy` skip those hooks and would fail. Create the placeholder here, before
/// `tauri_build::build()` validates it, so any cargo invocation works from a
/// fresh checkout. `beforeBundleCommand` still overwrites it with the real
/// binary for packaged builds; we only create one when absent.
fn ensure_relay_sidecar_placeholder() {
    let Ok(triple) = std::env::var("TARGET") else {
        return;
    };
    let exe = if triple.contains("windows") { ".exe" } else { "" };
    let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let dir = std::path::Path::new(&manifest).join("binaries");
    let dest = dir.join(format!("verun-mcp-relay-{triple}{exe}"));
    if !dest.exists() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&dest, b"");
    }
}
