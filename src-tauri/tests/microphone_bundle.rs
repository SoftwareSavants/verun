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
