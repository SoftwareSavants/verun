// Dev-only browser harness: renders the real app outside Tauri with mocked
// IPC over the demo seed data, so UI can be screenshotted headlessly.
// Run with: VITE_DEMO_MODE=true pnpm exec vite, then open /uilab.html
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') ?? 'dark'
document.documentElement.dataset.theme = theme
try {
  localStorage.setItem('verun:appearance', JSON.stringify({ mode: theme }))
  // Notification permission toast is noise for screenshots.
  localStorage.setItem('verun:notificationsPrompted', 'true')
} catch { /* ignore */ }

const FIXED: Record<string, unknown> = {
  default_bootstrap_dir: '/Users/dev/code',
  pty_list_for_task: [],
  // One agent blocked on the user, so "needs me" is represented on the floor.
  session_activity_snapshot: [{
    sessionId: 'demo-sess-perf-1', launch: 'uilab', revision: 1, phase: 'waiting',
    harness: 'claude', source: 'uilab', coverage: 'full', pending: ['Bash'],
  }],
}
const unknown = new Set<string>()
mockWindows('main')
mockIPC((cmd) => {
  if (!unknown.has(cmd)) { unknown.add(cmd); console.debug('[uilab] unmocked', cmd) }
  if (cmd in FIXED) return FIXED[cmd]
  if (/^(list|get_all)_|_snapshot$|_in_progress$/.test(cmd)) return []
  return null
}, { shouldMockEvents: true })

if (params.get('fixture') === 'scale') (await import('./scale')).seedScale()

await import('../index')

// Load PR / CI state for every task, as the live app does once remotes are polled.
{
  const [{ refreshTaskGit }, { tasks }] = await Promise.all([import('../store/git'), import('../store/tasks')])
  setTimeout(() => { for (const t of tasks) void refreshTaskGit(t.id, { local: false, remote: true }) }, 800)
}
