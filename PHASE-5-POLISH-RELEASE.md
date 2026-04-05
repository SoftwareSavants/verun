# Phase 5: Polish, Error Handling & Release

## Goal
Production-ready app: error handling, edge cases, performance optimization, app icon, and distribution.

## Prerequisites
- Phase 4 complete (full UI working)

## Work Items

### 1. Error Handling & Recovery
- **Session crash recovery**: detect unexpected exits, mark as 'error', show error output
- **Session resume on launch**: for sessions that were running when the app closed, offer to resume via `claude --resume`
- **Git errors**: handle dirty worktrees, merge conflicts, missing repos gracefully
- **Network/process errors**: if claude CLI not found, show setup instructions
- **DB corruption**: handle SQLite errors, add WAL mode for concurrent access
- **Stale worktrees**: on app launch, clean up worktrees for deleted tasks

### 2. Performance Optimization
- **Terminal rendering**: profile and optimize for many concurrent sessions
- **Memory**: implement LRU eviction for session output (keep 5 sessions in memory, rest on disk)
- **SQLite**: add WAL mode, tune page_size and cache_size
- **Bundle size**: tree-shake unused icons, analyze vite bundle
- **Startup time**: lazy-load SQLite data, don't block on DB hydration

### 3. macOS Integration
- **App icon**: design and add proper .icns icon
- **Menu bar**: native macOS menu with standard items (Edit, View, Window, Help)
- **Dock badge**: show running session count
- **Notifications**: macOS notification when session completes or errors
- **Spotlight**: register app metadata
- **Auto-update**: integrate tauri-plugin-updater for self-updates

### 4. Settings & Preferences
- New: `src/components/Settings.tsx`
- Claude Code path (auto-detect or manual)
- Default repository path
- Terminal font size / font family
- Max concurrent sessions limit
- Auto-cleanup: delete worktrees after N days
- Persist to SQLite settings table
- Project-level settings (future)

### 5. Task Name Derivation
- After first message in a session, ask Claude to summarize what it's working on
- Set as both the task name and first session name
- Show "Unnamed" in UI until derived

### 6. Logging & Debugging
- Add structured logging in Rust (use `tracing` crate)
- Log task/session lifecycle events, git operations, errors
- Add "Export logs" button in settings
- Add "Debug info" panel: Rust version, app version, OS version, claude version

### 7. Distribution
- Configure `tauri.conf.json` for production:
  - Code signing (Apple Developer ID)
  - Notarization
  - DMG background image
  - Universal binary (arm64 + x86_64)
- GitHub Actions CI/CD:
  - Build on push to main
  - Create GitHub Release with .dmg artifact
  - Auto-update feed URL

### 8. Documentation
- README with screenshots and feature list
- CONTRIBUTING.md for dev setup
- Architecture doc explaining the streaming pipeline
- User guide: how to use Verun effectively

## Testing Checklist
- [ ] 10 simultaneous sessions running without UI lag
- [ ] Stop session mid-output — no crashes, clean state
- [ ] Close app with running sessions — graceful shutdown
- [ ] Reopen app — sessions show as idle, output history intact, resume offered
- [ ] Merge with conflicts — clear error message
- [ ] Run for 1 hour with active sessions — no memory growth
- [ ] Fresh install on clean Mac — app works without prerequisites (except claude CLI)

## Acceptance Criteria
- [ ] Zero unhandled errors in normal usage
- [ ] App starts in < 2s
- [ ] DMG installs cleanly on macOS 13+
- [ ] Auto-update works
- [ ] All keyboard shortcuts documented
- [ ] App passes `cargo clippy` with zero warnings
- [ ] Frontend passes TypeScript strict mode
