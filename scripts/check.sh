#!/bin/bash
set -e

unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL \
  GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_PREFIX

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
