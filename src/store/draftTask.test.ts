import { beforeEach, expect, test, vi } from 'vitest'
const m = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), queue: vi.fn(), running: vi.fn(), failed: vi.fn(), select: vi.fn(), toast: vi.fn(), current: vi.fn(), model: vi.fn() }))
vi.mock('../lib/ipc', () => ({ createTask: m.create }))
vi.mock('./tasks', () => ({ setTasks: vi.fn() }))
vi.mock('./sessions', () => ({ setSessions: vi.fn(), setOutputItems: vi.fn(), sendMessage: m.send, updateSessionModel: m.model }))
vi.mock('./setup', () => ({ isSetupRunning: m.running, setupFailed: m.failed, queueMessage: m.queue }))
vi.mock('./ui', () => ({ selectedTaskId: m.current, setSelectedProjectId: vi.fn(), setSelectedTaskId: m.select, setSelectedSessionIdForTask: vi.fn(), setShowArchived: vi.fn(), addToast: m.toast }))
import { startDraftTask } from './draftTask'
const input = { projectId: 'p', baseBranch: 'main', agentType: 'claude' as const, directory: '/notes', message: 'Organize notes' }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); m.current.mockReturnValue(null)
  m.create.mockResolvedValue({ task: { id: 'task', projectId: 'p' }, session: { id: 'session' } })
  m.send.mockResolvedValue(true); m.running.mockReturnValue(false); m.failed.mockReturnValue(false)
})
test('first message targets the new session in the chosen folder', async () => {
  await startDraftTask(input)
  expect(m.create).toHaveBeenCalledWith('p', 'main', 'claude', '/notes', undefined)
  expect(m.select).toHaveBeenCalledWith('task')
  expect(m.send).toHaveBeenCalledWith('session', 'Organize notes', undefined, undefined)
})
test('the account picked for the task goes to task creation', async () => {
  await startDraftTask({ ...input, account: { kind: 'account', id: 'a1' } })
  expect(m.create).toHaveBeenCalledWith('p', 'main', 'claude', '/notes', { kind: 'account', id: 'a1' })
})
test('so does the project default, when that is what was chosen', async () => {
  await startDraftTask({ ...input, account: { kind: 'projectDefault' } })
  expect(m.create).toHaveBeenCalledWith('p', 'main', 'claude', '/notes', { kind: 'projectDefault' })
})
test('waits for setup before delivering the first message', async () => {
  m.running.mockReturnValue(true)
  await startDraftTask(input)
  expect(m.send).not.toHaveBeenCalled()
  expect(m.queue).toHaveBeenCalledWith('task', { sessionId: 'session', message: 'Organize notes' })
})
test('send failure preserves the prompt and completes creation without inviting duplicate retry', async () => {
  m.send.mockRejectedValue(new Error('offline'))
  await expect(startDraftTask(input)).resolves.toBeUndefined()
  expect(localStorage.getItem('verun:draft-msg:session')).toBe('Organize notes')
  expect(m.toast).toHaveBeenCalledOnce()
  expect(m.create).toHaveBeenCalledOnce()
})
test('a delivered first message clears the retained prompt', async () => {
  await startDraftTask(input)
  expect(localStorage.getItem('verun:draft-msg:session')).toBeNull()
})
// sendMessage has shown the account toast and resolved false: the agent did not
// start, so the prompt stays for the user to send once the account works.
test('a first message blocked by an account problem keeps the prompt and still opens the task', async () => {
  m.send.mockResolvedValue(false)
  await expect(startDraftTask(input)).resolves.toBeUndefined()
  expect(localStorage.getItem('verun:draft-msg:session')).toBe('Organize notes')
  expect(m.select).toHaveBeenCalledWith('task')
  expect(m.toast).not.toHaveBeenCalled()
  expect(m.create).toHaveBeenCalledOnce()
})
test('creation failure leaves the draft available and never sends', async () => {
  m.create.mockRejectedValue(new Error('folder missing'))
  await expect(startDraftTask(input)).rejects.toThrow('folder missing')
  expect(m.send).not.toHaveBeenCalled()
  expect(m.select).not.toHaveBeenCalled()
})
test('does not mount a composer with the already-sent draft while the agent starts', async () => {
  let resolve!: (sent: boolean) => void
  m.send.mockReturnValue(new Promise<boolean>(r => { resolve = r }))
  const pending = startDraftTask(input)
  await Promise.resolve()
  await Promise.resolve()
  expect(m.select).not.toHaveBeenCalled()
  resolve(true)
  await pending
  expect(m.select).toHaveBeenCalledWith('task')
})

test('finishing creation does not steal focus after switching to another task', async () => {
  let resolve!: (sent: boolean) => void
  m.send.mockReturnValue(new Promise<boolean>(r => { resolve = r }))
  const pending = startDraftTask(input)
  await Promise.resolve()
  await Promise.resolve()
  m.current.mockReturnValue('other-task')
  resolve(true)
  await pending
  expect(m.select).not.toHaveBeenCalled()
})

test('chosen model is persisted and sent on the first turn', async () => {
  await startDraftTask({ ...input, model: 'chosen-model' })
  expect(m.model).toHaveBeenCalledWith('session', 'chosen-model')
  expect(m.send).toHaveBeenCalledWith('session', 'Organize notes', undefined, 'chosen-model')
})
test('chosen model survives setup queuing', async () => {
  m.running.mockReturnValue(true)
  await startDraftTask({ ...input, model: 'chosen-model' })
  expect(m.queue).toHaveBeenCalledWith('task', expect.objectContaining({ model: 'chosen-model' }))
})
