// Off Apple Silicon the service is compiled but never started, so most of it is unused there.
#![cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), allow(dead_code))]

pub mod capture;
pub mod catalog;
pub mod engine;
pub mod hold;
#[cfg(target_os = "macos")]
pub mod hotkey_macos;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub mod mic_permission_macos;
pub mod models;
pub mod runtime;
pub mod service;
pub mod session;
