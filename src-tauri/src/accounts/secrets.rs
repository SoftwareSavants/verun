//! Secret env vars of accounts (API keys) live in the OS keychain, never in
//! SQLite or process arguments. `SecretStore` is the seam: the app uses the
//! keychain implementation and tests use the in-memory one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The secret env vars of accounts, addressed by account id and env var name.
/// A missing entry is not an error: `get` returns `None` and `delete` succeeds.
/// Implementations may block, so async callers go through `spawn_blocking`.
pub trait SecretStore: Send + Sync {
    fn get(&self, account_id: &str, key: &str) -> Result<Option<String>, String>;
    fn set(&self, account_id: &str, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account_id: &str, key: &str) -> Result<(), String>;
}

/// An in-memory `SecretStore` for tests.
#[cfg_attr(not(test), allow(dead_code))] // only tests build one
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<(String, String), String>>,
}

impl MemorySecretStore {
    fn slot(account_id: &str, key: &str) -> (String, String) {
        (account_id.to_string(), key.to_string())
    }
}

impl SecretStore for MemorySecretStore {
    fn get(&self, account_id: &str, key: &str) -> Result<Option<String>, String> {
        let entries = self.entries.lock().unwrap();
        Ok(entries.get(&Self::slot(account_id, key)).cloned())
    }

    fn set(&self, account_id: &str, key: &str, value: &str) -> Result<(), String> {
        let mut entries = self.entries.lock().unwrap();
        entries.insert(Self::slot(account_id, key), value.to_string());
        Ok(())
    }

    fn delete(&self, account_id: &str, key: &str) -> Result<(), String> {
        let mut entries = self.entries.lock().unwrap();
        entries.remove(&Self::slot(account_id, key));
        Ok(())
    }
}

/// A keychain that refuses every call, for the tests of what happens when the
/// real one is locked.
#[cfg(test)]
pub(crate) struct LockedKeychain;

#[cfg(test)]
impl SecretStore for LockedKeychain {
    fn get(&self, _account_id: &str, _key: &str) -> Result<Option<String>, String> {
        Err("keychain is locked".into())
    }

    fn set(&self, _account_id: &str, _key: &str, _value: &str) -> Result<(), String> {
        Err("keychain is locked".into())
    }

    fn delete(&self, _account_id: &str, _key: &str) -> Result<(), String> {
        Err("keychain is locked".into())
    }
}

/// A `SecretStore` backed by the OS credential store: the macOS login
/// keychain, Windows Credential Manager or the Linux kernel keyring.
///
/// Every call blocks on the OS and can sit behind a keychain unlock or access
/// prompt, so async callers must run it inside `tokio::task::spawn_blocking`,
/// never on the runtime or the UI thread. The OS stores do not serialize
/// concurrent access to one entry reliably, so don't hit the same entry from
/// several threads at once.
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    pub fn new(service: String) -> Self {
        Self { service }
    }

    fn entry(&self, account_id: &str, key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &keychain_user(account_id, key))
            .map_err(|e| e.to_string())
    }
}

impl SecretStore for KeychainSecretStore {
    fn get(&self, account_id: &str, key: &str) -> Result<Option<String>, String> {
        missing_is_none(self.entry(account_id, key)?.get_password())
    }

    fn set(&self, account_id: &str, key: &str, value: &str) -> Result<(), String> {
        self.entry(account_id, key)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account_id: &str, key: &str) -> Result<(), String> {
        missing_is_none(self.entry(account_id, key)?.delete_credential()).map(|_| ())
    }
}

/// Turns the keychain's "no such entry" into `None`: nothing stored is an
/// ordinary answer, not a failure. Other errors are reported with `Display`;
/// the `Debug` of `BadEncoding` carries the stored secret's bytes.
fn missing_is_none<T>(result: keyring::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The keychain service of this build's account secrets. It carries the bundle
/// identifier, so a dev build and the installed app keep separate secrets.
pub fn keychain_service(bundle_identifier: &str) -> String {
    format!("{bundle_identifier}.accounts")
}

/// The keychain user (the "account" column in Keychain Access) of one secret
/// env var of one account.
pub fn keychain_user(account_id: &str, key: &str) -> String {
    format!("{account_id}/{key}")
}

/// The app's secret store, registered as Tauri managed state.
pub struct Secrets(pub Arc<dyn SecretStore>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_set_get_delete() {
        let store = MemorySecretStore::default();
        store.set("a1", "ANTHROPIC_API_KEY", "sk-one").unwrap();
        assert_eq!(
            store.get("a1", "ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("sk-one")
        );

        // A second set replaces the value.
        store.set("a1", "ANTHROPIC_API_KEY", "sk-two").unwrap();
        assert_eq!(
            store.get("a1", "ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("sk-two")
        );

        // Entries are keyed by (account, key): deleting one leaves the rest.
        store.set("a2", "ANTHROPIC_API_KEY", "sk-other").unwrap();
        store.set("a1", "OPENAI_API_KEY", "sk-third").unwrap();
        store.delete("a1", "ANTHROPIC_API_KEY").unwrap();
        assert_eq!(store.get("a1", "ANTHROPIC_API_KEY").unwrap(), None);
        assert_eq!(
            store.get("a2", "ANTHROPIC_API_KEY").unwrap().as_deref(),
            Some("sk-other")
        );
        assert_eq!(
            store.get("a1", "OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-third")
        );
    }

    #[test]
    fn memory_store_missing_is_none_and_delete_missing_is_ok() {
        let store = MemorySecretStore::default();
        assert_eq!(store.get("a1", "ANTHROPIC_API_KEY").unwrap(), None);
        assert_eq!(store.delete("a1", "ANTHROPIC_API_KEY"), Ok(()));
        // Still fine the second time, and with other entries around.
        store.set("a1", "OPENAI_API_KEY", "sk-x").unwrap();
        assert_eq!(store.delete("a1", "ANTHROPIC_API_KEY"), Ok(()));
        assert_eq!(
            store.get("a1", "OPENAI_API_KEY").unwrap().as_deref(),
            Some("sk-x")
        );
    }

    #[test]
    fn keychain_user_format() {
        assert_eq!(
            keychain_user("a1", "ANTHROPIC_API_KEY"),
            "a1/ANTHROPIC_API_KEY"
        );
    }

    #[test]
    fn keychain_service_is_per_bundle() {
        assert_eq!(keychain_service("com.verun.dev"), "com.verun.dev.accounts");
    }

    #[test]
    fn keychain_no_entry_is_none_and_other_errors_surface() {
        assert_eq!(
            missing_is_none::<String>(Err(keyring::Error::NoEntry)),
            Ok(None)
        );
        assert_eq!(
            missing_is_none(Ok("sk-one".to_string())),
            Ok(Some("sk-one".to_string()))
        );
        // The message names the failure and never the stored bytes.
        let err = missing_is_none::<String>(Err(keyring::Error::BadEncoding(b"sk-bytes".to_vec())))
            .unwrap_err();
        assert_eq!(err, "Data is not UTF-8 encoded");
    }

    // Manual: talks to the real OS keychain, and its first access may prompt.
    //   cargo test accounts::secrets -- --ignored
    // It has a service of its own, so it never touches real account secrets,
    // and its entry is removed even when an assertion fails.
    #[test]
    #[ignore]
    fn keychain_round_trip_real() {
        const ACCOUNT: &str = "round-trip";
        const KEY: &str = "VERUN_TEST_KEY";

        struct Cleanup(KeychainSecretStore);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete(ACCOUNT, KEY);
            }
        }

        let cleanup = Cleanup(KeychainSecretStore::new(
            "com.verun.test.accounts".to_string(),
        ));
        let store = &cleanup.0;

        // A run that was killed before it cleaned up must not fail this one.
        store.delete(ACCOUNT, KEY).unwrap();
        assert_eq!(store.get(ACCOUNT, KEY).unwrap(), None);

        store.set(ACCOUNT, KEY, "first").unwrap();
        assert_eq!(store.get(ACCOUNT, KEY).unwrap().as_deref(), Some("first"));
        // A second set replaces the value.
        store.set(ACCOUNT, KEY, "second").unwrap();
        assert_eq!(store.get(ACCOUNT, KEY).unwrap().as_deref(), Some("second"));

        store.delete(ACCOUNT, KEY).unwrap();
        assert_eq!(store.get(ACCOUNT, KEY).unwrap(), None);
        // Deleting what is already gone is not an error.
        store.delete(ACCOUNT, KEY).unwrap();
    }
}
