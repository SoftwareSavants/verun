import { expect, test, vi } from 'vitest'
const m = vi.hoisted(() => ({ handler: null as null | ((event: any) => void), send: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn((_name, callback) => { m.handler = callback; return Promise.resolve(() => {}) }) }))
vi.mock('../lib/ipc', () => ({ getSetupInProgress: vi.fn().mockResolvedValue([]) }))
vi.mock('./terminals', () => ({ registerHookTerminal: vi.fn() }))
vi.mock('./ui', () => ({ selectedTaskId: () => null, setShowTerminal: vi.fn() }))
vi.mock('../lib/windowContext', () => ({ isTaskOwnedByThisWindow: () => true }))
vi.mock('./sessions', () => ({ sendMessage: m.send }))
import { initSetupListeners, queueMessage, queuedMessages } from './setup'
test('a failed setup retains the initial prompt for editing or sending after retry', async () => {
  await initSetupListeners()
  queueMessage('task', { sessionId: 'session', message: 'Fix bug' })
  m.handler!({ payload: { taskId: 'task', status: 'failed', error: 'install failed' } })
  expect(queuedMessages.task?.message).toBe('Fix bug')
  expect(m.send).not.toHaveBeenCalled()
  m.handler!({ payload: { taskId: 'task', status: 'completed' } })
  await vi.waitFor(() => expect(m.send).toHaveBeenCalledOnce())
  expect(queuedMessages.task).toBeUndefined()
})
