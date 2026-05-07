#!/bin/bash
set -e

echo "→ Ensuring MCP relay sidecar placeholder..."
node src-tauri/scripts/copy-relay-sidecar.mjs

echo "→ Checking frontend types..."
pnpm check

echo "→ Checking Rust..."
cargo check --manifest-path src-tauri/Cargo.toml

echo "→ Running Rust tests..."
cargo test --manifest-path src-tauri/Cargo.toml

echo "→ Running frontend tests..."
pnpm test

echo "→ Clippy..."
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

echo "✓ All checks passed"
