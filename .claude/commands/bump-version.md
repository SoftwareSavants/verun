---
name: bump-version
description: Bump the version number across all project files and update the changelog
user_invocable: true
---

# Bump Version

Bump the project version across all files and prepare a changelog entry.

## Arguments

The user provides the new version number (e.g., `0.2.0`). If no version is given, ask for one.

## Steps

1. Read the current version from `VERSION`
2. Update the version in all four files:
   - `VERSION`
   - `package.json` (the `"version"` field)
   - `src-tauri/tauri.conf.json` (the `"version"` field)
   - `src-tauri/Cargo.toml` (the `version` field under `[package]`)
3. Add a new section at the top of `CHANGELOG.md` (below the `# Changelog` heading):
   ```
   ## <new-version> — <today's date YYYY-MM-DD>

   ### Changes

   -
   ```
4. Tell the user the version has been bumped and remind them to fill in the changelog before pushing.

## Rules

- Do NOT commit or push — the user will do that after editing the changelog.
- Do NOT modify any other files.
- Verify the old version matches across all four files before bumping. If they're out of sync, warn the user and stop.
