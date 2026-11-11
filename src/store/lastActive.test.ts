import { beforeEach, expect, test, vi } from 'vitest'

type Listener = (e: { payload: unknown }) => void
const listeners = new Map<string, Listener[]>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, cb: Listener) => {
    listeners.set(name, [...(listeners.get(name) || []), cb])
    return Promise.resolve(() => {})
  }),
}))
vi.mock('../lib/ipc', () => ({ taskLastActive: vi.fn(() => Promise.resolve({ t1: 5000 })) }))
const fire = (name: string, payload: unknown) => listeners.get(name)?.forEach(cb => cb({ payload }))

import { setSessions } from './sessions'
import { initLastActive, lastActiveAt } from './lastActive'
import { DEMO_SESSIONS } from '../lib/seedData'

beforeEach(() => setSessions([{ ...DEMO_SESSIONS[0], id: 's1', taskId: 't1' }]))

test('loads when tasks were last active, falling back to when a task was created', async () => {
  await initLastActive()
  expect(lastActiveAt({ id: 't1', createdAt: 1 })).toBe(5000)
  expect(lastActiveAt({ id: 'other', createdAt: 42 })).toBe(42)
})

test('a turn starting or ending in chat or the terminal moves its task to now', async () => {
  await initLastActive()
  vi.spyOn(Date, 'now').mockReturnValue(9000)
  fire('session-status', { sessionId: 's1', status: 'running' })
  expect(lastActiveAt({ id: 't1', createdAt: 1 })).toBe(9000)
  vi.spyOn(Date, 'now').mockReturnValue(12000)
  fire('session-touched', 's1')
  expect(lastActiveAt({ id: 't1', createdAt: 1 })).toBe(12000)
})
