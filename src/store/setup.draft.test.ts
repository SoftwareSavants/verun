import { expect, test, vi } from 'vitest'
const m = vi.hoisted(() => ({ handler: null as null | ((event: any) => void), send: vi.fn().mockResolvedValue(true) }))
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
// The prompt waits in the queue while setup runs and is sent when it completes.
// When the session's account stops that send (sendMessage resolves false after
// showing its toast), the prompt stays queued for the user to edit and send.
test('a queued prompt the account stops stays queued, and one that was sent does not', async () => {
  await initSetupListeners()
  m.send.mockClear()

  m.send.mockResolvedValueOnce(false)
  queueMessage('blocked-task', { sessionId: 'session', message: 'Fix bug', model: 'opus' })
  m.handler!({ payload: { taskId: 'blocked-task', status: 'completed' } })
  await vi.waitFor(() => expect(queuedMessages['blocked-task']).toEqual({ sessionId: 'session', message: 'Fix bug', model: 'opus' }))

  m.send.mockResolvedValueOnce(true)
  queueMessage('sent-task', { sessionId: 'session', message: 'Fix bug' })
  m.handler!({ payload: { taskId: 'sent-task', status: 'completed' } })
  await vi.waitFor(() => expect(m.send).toHaveBeenCalledTimes(2))
  await Promise.resolve()
  expect(queuedMessages['sent-task']).toBeUndefined()
})
