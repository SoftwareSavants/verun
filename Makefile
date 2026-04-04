.PHONY: dev build check test lint setup clean

dev:
	pnpm tauri dev

build:
	pnpm tauri build

check:
	bash scripts/check.sh

test:
	cargo test --manifest-path src-tauri/Cargo.toml

lint:
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

setup:
	bash scripts/setup.sh

clean:
	rm -rf target dist node_modules .tauri
