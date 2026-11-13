use std::path::Path;

#[test]
fn macos_bundle_allows_terminal_microphone_access() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    // Tauri also embeds this conventional file into unbundled macOS dev builds.
    let info = plist::Value::from_file(root.join("Info.plist"))
        .expect("macOS needs a microphone usage description");
    let description = info
        .as_dictionary()
        .unwrap()
        .get("NSMicrophoneUsageDescription")
        .and_then(plist::Value::as_string)
        .expect("microphone usage description must be a string");
    assert!(!description.trim().is_empty());

    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let path = config["bundle"]["macOS"]["entitlements"]
        .as_str()
        .expect("bundle signing must use the microphone entitlement");
    let entitlements = plist::Value::from_file(root.join(path)).unwrap();
    assert_eq!(
        entitlements
            .as_dictionary()
            .unwrap()
            .get("com.apple.security.device.audio-input")
            .and_then(plist::Value::as_boolean),
        Some(true)
    );
}

#[test]
fn microphone_usage_text_mentions_dictation() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let info = plist::Value::from_file(root.join("Info.plist")).unwrap();
    let description = info
        .as_dictionary()
        .unwrap()
        .get("NSMicrophoneUsageDescription")
        .and_then(plist::Value::as_string)
        .unwrap();
    assert!(description.contains("dictation"));
}

#[test]
fn macos_builds_target_at_least_10_15_for_whisper_cpp() {
    // `tauri build` sets MACOSX_DEPLOYMENT_TARGET from this (10.13 when unset),
    // and whisper.cpp uses std::filesystem, which macOS has from 10.15.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let min = config["bundle"]["macOS"]["minimumSystemVersion"]
        .as_str()
        .expect("set bundle.macOS.minimumSystemVersion");
    let parts: Vec<u32> = min.split('.').map(|p| p.parse().unwrap()).collect();
    assert!(parts >= vec![10, 15], "{min} is below 10.15");
}
