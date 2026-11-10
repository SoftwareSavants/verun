import { beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { produce } from 'solid-js/store'

vi.mock('../lib/notifications', () => ({ notify: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))

import { notify } from '../lib/notifications'
import { initSessionNotifications } from './sessionNotifications'
import { setSessions, setPendingApprovals, setAbortingSessions } from './sessions'
import { setSessionActivity } from './activity'
import { setTasks } from './tasks'
import { makeSession } from '../test/sessionFixtures'
import { DEMO_TASKS } from '../lib/seedData'
import type { ToolApprovalRequest } from '../types'
import type { SessionActivity } from '../lib/sessionActivity'

const tick = () => new Promise(r => setTimeout(r, 0))
const titles = () => vi.mocked(notify).mock.calls.map(c => c[0].title)
const bodies = () => vi.mocked(notify).mock.calls.map(c => c[0].body)
const status = (id: string, s: string) => setSessions(x => x.id === id, 'status', s as never)
const phase = (sessionId: string, p: SessionActivity['phase'], interrupted = false, revision = 1) =>
  setSessionActivity(sessionId, { sessionId, launch: 'l', revision, phase: p, harness: 'claude', source: 'hooks', coverage: 'partial', pending: [], interrupted })
const wipe = (s: Record<string, unknown>) => { for (const k of Object.keys(s)) delete s[k] }

beforeAll(() => initSessionNotifications())
beforeEach(async () => {
  setPendingApprovals(produce(s => wipe(s)))
  setAbortingSessions(produce(s => wipe(s)))
  setTasks([{ ...DEMO_TASKS[0], id: 't1', name: 'Refactor auth' }])
  setSessions([])
  await tick()
  vi.mocked(notify).mockClear()
})

async function start(overrides = {}) {
  setSessions([makeSession({ id: 's1', taskId: 't1', name: null, status: 'running', ...overrides })])
  await tick()
  vi.mocked(notify).mockClear()
}

test('a chat turn that finishes notifies once, named after the session or else the task (#247)', async () => {
  await start({ name: 'Fix login retry' })
  status('s1', 'idle'); await tick()
  expect(titles()).toEqual(['Task completed'])
  expect(bodies()).toEqual(['Fix login retry'])
})

test('falls back to the task name', async () => {
  await start()
  status('s1', 'idle'); await tick()
  expect(bodies()).toEqual(['Refactor auth'])
})

test('pressing Stop yourself is not a completion', async () => {
  await start()
  setAbortingSessions('s1', true)
  status('s1', 'idle'); await tick()
  expect(notify).not.toHaveBeenCalled()
})

test('background agents keep it quiet until all work settles', async () => {
  await start()
  status('s1', 'background'); await tick()
  expect(notify).not.toHaveBeenCalled()
  status('s1', 'idle'); await tick()
  expect(titles()).toEqual(['Task completed'])
})

test('an approval notifies once per wait, with what it is for (#247)', async () => {
  await start({ name: 'Fix login retry' })
  const req = (id: string): ToolApprovalRequest => ({ sessionId: 's1', requestId: id, toolName: 'Bash', toolInput: {} })
  setPendingApprovals('s1', [req('r1')]); await tick()
  setPendingApprovals('s1', [req('r1'), req('r2')]); await tick()
  expect(titles()).toEqual(['Approval needed'])
  expect(bodies()).toEqual(['Fix login retry: Bash'])
})

test('a terminal session that finishes notifies; your own Esc does not', async () => {
  await start({ status: 'idle' })
  phase('s1', 'working', false, 1); await tick()
  phase('s1', 'idle', false, 2); await tick()
  expect(titles()).toEqual(['Task completed'])
  vi.mocked(notify).mockClear()
  phase('s1', 'working', false, 3); await tick()
  phase('s1', 'idle', true, 4); await tick()
  expect(notify).not.toHaveBeenCalled()
})

test('a terminal waiting on you says so', async () => {
  await start({ status: 'idle' })
  phase('s1', 'working', false, 1); await tick()
  phase('s1', 'waiting', false, 2); await tick()
  expect(titles()).toEqual(['Claude needs you'])
})
