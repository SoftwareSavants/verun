.PHONY: dev build check test test-rust test-frontend lint setup clean

dev:
	pnpm tauri dev --config src-tauri/tauri.dev.conf.json --features dev-notifications

build:
	pnpm tauri build

check:
	bash scripts/check.sh

test: test-rust test-frontend

test-rust:
	cargo test --manifest-path src-tauri/Cargo.toml

test-frontend:
	pnpm test

lint:
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

setup:
	bash scripts/setup.sh

clean:
	rm -rf target dist node_modules .tauri
