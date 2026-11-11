// ?fixture=scale: grow the demo floor to 6 projects / ~30 live tasks so layouts
// are judged at factory scale, not just at the happy-path demo size.
import { DEMO_PROJECTS, DEMO_TASKS, DEMO_SESSIONS } from '../lib/seedData'

const NOW = 1744617600000
const EXTRA: Record<string, string[]> = {
  'mobile-app': ['Offline sync queue', 'Push notification opt-in', 'Fix iPad split view', 'Biometric login', 'Crash on cold start'],
  'billing': ['Proration for mid-cycle upgrades', 'Stripe webhook retries', 'Invoice PDF redesign', 'Tax ID validation for EU customers', 'Dunning email cadence', 'Usage meter rollups'],
  'docs-site': ['Search ranking tweaks', 'Versioned API reference', 'Dark mode code blocks', 'Broken link checker'],
}
// Cycle through live states; 'error' lands a couple of extra tasks in "Needs you".
const STATES = ['running', 'idle', 'running', 'idle', 'error', 'idle'] as const

export function seedScale() {
  let n = 0
  for (const [name, taskNames] of Object.entries(EXTRA)) {
    const projectId = `scale-proj-${name}`
    DEMO_PROJECTS.push({ ...DEMO_PROJECTS[0], id: projectId, name, repoPath: `/Users/dev/${name}`, createdAt: NOW - n * 1000 })
    for (const taskName of taskNames) {
      const id = `scale-task-${n}`
      const slug = taskName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)
      DEMO_TASKS.push({ ...DEMO_TASKS[0], id, projectId, name: taskName, branch: `feat/${slug}`, worktreePath: `/Users/dev/${name}/.verun/worktrees/${slug}`, createdAt: NOW - n * 60_000 })
      DEMO_SESSIONS.push({ ...DEMO_SESSIONS[0], id: `scale-sess-${n}`, taskId: id, name: null, status: STATES[n % STATES.length], startedAt: NOW - n * 60_000 })
      n++
    }
  }
}

// ?fixture=long: a realistic long-running session (~150 turns, a few thousand
// output lines with markdown and code) on both demo sessions, to measure the
// cost of opening and appending to big transcripts.
export async function seedLongTranscript(turns = 25) {
  const { DEMO_OUTPUT_LINES } = await import('../lib/seedData')
  for (const [sessionId, base] of Object.entries(DEMO_OUTPUT_LINES)) {
    const grown = []
    let id = 1
    for (let t = 0; t < turns; t++) {
      for (const line of base) grown.push({ ...line, id: id++, sessionId, emittedAt: line.emittedAt + t * 3_600_000 })
    }
    DEMO_OUTPUT_LINES[sessionId] = grown
  }
}

// ?fixture=recent: the scale floor with realistic recency (a few tasks touched
// in the last hours, the rest days or weeks ago), shown in the recent view.
export function seedRecentView() {
  seedScale()
  const now = Date.now()
  const H = 3_600_000
  const ages = [0.2, 1, 3, 5, 9, 26, 50, 80, 140, 300, 600]
  DEMO_SESSIONS.forEach((s, i) => { s.startedAt = now - ages[i % ages.length] * H - i * 60_000 })
  DEMO_SESSIONS.slice(0, 3).forEach(s => { s.status = 'idle' })
  try { localStorage.setItem('verun:sidebarView', 'recent') } catch { /* ignore */ }
}
