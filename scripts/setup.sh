#!/bin/bash
set -e

echo "→ Setting up Verun dev environment"

# Check Rust
if ! command -v rustc &> /dev/null; then
  echo "→ Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

# Required Rust target for macOS
rustup target add aarch64-apple-darwin
rustup target add x86_64-apple-darwin

# Rust tools
cargo install cargo-watch
cargo install tauri-cli --version "^2"

# Check pnpm
if ! command -v pnpm &> /dev/null; then
  echo "→ Installing pnpm..."
  npm install -g pnpm
fi

# Install frontend deps
pnpm install

# Check Tauri system deps (macOS only)
if [[ "$OSTYPE" == "darwin"* ]]; then
  if ! command -v xcode-select &> /dev/null; then
    echo "→ Installing Xcode CLI tools..."
    xcode-select --install
  fi
fi

# Install git hooks
echo "→ Installing git hooks..."
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

echo "✓ Setup complete. Run: pnpm tauri dev"
