import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ targets: [] as Array<{ id: string; draftId: string; insert(take: string): void }>, start: vi.fn(), open: vi.fn(), inspect: vi.fn(), project: { id: 'p', name: 'Project', repoPath: '/repo', baseBranch: 'main', defaultAgentType: 'claude' } as Record<string, string> }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('../lib/ipc', () => ({
  getRepoInfo: vi.fn().mockResolvedValue({ branches: ['main', 'develop'], currentBranch: 'develop' }),
  refreshAgents: vi.fn().mockResolvedValue(undefined),
  claudeCloudAvailability: vi.fn().mockResolvedValue({ available: false, reason: null }),
  inspectTaskDirectory: mocks.inspect,
}))
vi.mock('../store/projects', () => ({ projectById: () => mocks.project, projects: [] }))
vi.mock('../store/agents', () => ({ agents: [{ id: 'claude', name: 'Claude Code', installed: true, supportsModelSelection: true, models: [{ id: 'opus', label: 'Opus', description: '' }] }, { id: 'codex', name: 'Codex', installed: true, supportsModelSelection: true, models: [{ id: 'gpt', label: 'GPT', description: '' }] }] }))
vi.mock('../store/draftTask', () => ({ startDraftTask: mocks.start }))
vi.mock('./AgentPicker', () => ({ AgentPicker: () => <span>Claude</span> }))
vi.mock('./CloudSessionPicker', () => ({ CloudSessionPicker: () => null }))
vi.mock('./DictationControl', () => ({ DictationControl: (p: { available: boolean }) => <span data-testid="dictation" data-available={String(p.available)} /> }))
vi.mock('../store/voice', () => ({
  registerDictationTarget: (t: (typeof mocks.targets)[number]) => {
    mocks.targets.push(t)
    return () => { mocks.targets = mocks.targets.filter(x => x !== t) }
  },
}))
import { NewTaskView } from './NewTaskView'
import { appendToDraft, loadDraftMessage, newTaskDraftId, saveDraftMessage } from '../store/sessionDrafts'
import { toasts, setToasts, setSelectedTaskId, setShowTaskBoard } from '../store/ui'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeSnapshot } from '../test/accountFixtures'
/** jsdom has no execCommand: `insertText` into a focused textarea as WebKit does it (input event, caret after). */
const execCommand = vi.fn((command: string, _ui?: boolean, text?: string): boolean => {
  const el = document.activeElement
  if (command !== 'insertText' || text === undefined || !(el instanceof HTMLTextAreaElement)) return false
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})
Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })
afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); mocks.targets = []; setSelectedTaskId(null); setShowTaskBoard(false); mocks.project = { id: 'p', name: 'Project', repoPath: '/repo', baseBranch: 'main', defaultAgentType: 'claude' }; localStorage.clear(); setToasts([]); applySnapshot(makeSnapshot()); mocks.start.mockResolvedValue(undefined) })
function select(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}
test('opening a draft creates nothing; first send creates task and sends the prompt', async () => {
  const close = vi.fn()
  render(() => <NewTaskView projectId="p" onClose={close} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(mocks.start).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Fix the bug' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', message: 'Fix the bug', baseBranch: 'main', directory: undefined })))
  expect(close).toHaveBeenCalledOnce()
})
test('project folder is sent explicitly without an isolated worktree', async () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  select('Run in', 'Project folder')
  expect(screen.queryByRole('combobox', { name: 'Base branch' })).toBeNull()
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Investigate' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo' })))
})
test('a selected non-Git folder is shown and creation errors preserve the prompt', async () => {
  mocks.open.mockResolvedValue('/notes')
  mocks.inspect.mockResolvedValue({ path: '/notes', branch: '', isGit: false })
  mocks.start.mockRejectedValue(new Error('Agent unavailable'))
  const close = vi.fn()
  render(() => <NewTaskView projectId="p" onClose={close} />)
  select('Run in', 'Choose folder…')
  await screen.findByText('/notes')
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Organize notes' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByRole('alert')
  expect((screen.getByRole('textbox', { name: 'Task prompt' }) as HTMLTextAreaElement).value).toBe('Organize notes')
  expect(close).not.toHaveBeenCalled()
})

// The account the task would run on can be unusable (removed, a secret the
// keychain won't give). The draft says so in words, with the account toast that
// leads to the fix, instead of printing the backend's raw error string.
test('an account problem from task creation is told in words with its toast, and the prompt stays', async () => {
  mocks.start.mockRejectedValue('ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}')
  const close = vi.fn()
  render(() => <NewTaskView projectId="p" onClose={close} />)
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Fix the bug' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Acme was removed. Start a new session on another account.')
  expect(toasts().map(t => ({ title: t.title, actions: t.actions?.map(a => a.label) }))).toEqual([
    { title: 'Account removed', actions: ['Choose account'] },
  ])
  expect((screen.getByRole('textbox', { name: 'Task prompt' }) as HTMLTextAreaElement).value).toBe('Fix the bug')
  expect(close).not.toHaveBeenCalled()
})

test('the combined picker passes both harness and model into task creation', async () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
  fireEvent.click(screen.getByRole('button', { name: 'GPT' }))
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Build this' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'codex', model: 'gpt' })))
})

// A task starts on the project's account for its harness unless another is
// picked next to the model. The pick is for the project it was made in.
function send(message: string) {
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: message } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}
const acme = makeAccount()
const projectDefault = { kind: 'projectDefault' }

test('send passes the account selection to startDraftTask', async () => {
  applySnapshot(makeSnapshot({ accounts: [acme] }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Acme' }))
  fireEvent.click(screen.getByRole('button', { name: 'Opus' }))
  expect(screen.getByRole('button', { name: 'Choose model: Opus · Acme' })).toBeTruthy()
  send('Fix the bug')
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'claude', model: 'opus', account: { kind: 'account', id: 'a1' } })))
})

test('without a pick the task goes to the project account', async () => {
  applySnapshot(makeSnapshot({ accounts: [acme] }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  send('Fix the bug')
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ account: projectDefault })))
})

test('a project that uses an account shows it on the picker', () => {
  applySnapshot(makeSnapshot({ accounts: [acme], projectAccounts: [{ projectId: 'p', agentType: 'claude', accountId: 'a1' }] }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  expect(screen.getByRole('button', { name: 'Choose model: Opus · Acme' })).toBeTruthy()
})

test('picking Default is sent as Default, not as the project account', async () => {
  applySnapshot(makeSnapshot({ accounts: [acme], projectAccounts: [{ projectId: 'p', agentType: 'claude', accountId: 'a1' }] }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus · Acme' }))
  fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Default' }))
  fireEvent.click(screen.getByRole('button', { name: 'Opus' }))
  send('Fix the bug')
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ account: { kind: 'default' } })))
})

test('picking another harness takes the account pick back', async () => {
  applySnapshot(makeSnapshot({ accounts: [acme] }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Acme' }))
  fireEvent.click(screen.getByRole('button', { name: 'Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus · Acme' }))
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
  fireEvent.click(screen.getByRole('button', { name: 'GPT' }))
  send('Build this')
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'codex', account: projectDefault })))
})

test('the pick is dropped when the project changes', async () => {
  applySnapshot(makeSnapshot({ accounts: [acme] }))
  const [projectId, setProjectId] = createSignal('p')
  render(() => <NewTaskView projectId={projectId()} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Acme' }))
  fireEvent.click(screen.getByRole('button', { name: 'Opus' }))
  expect(screen.getByRole('button', { name: 'Choose model: Opus · Acme' })).toBeTruthy()
  setProjectId('q')
  expect(screen.getByRole('button', { name: 'Choose model: Opus' })).toBeTruthy()
  send('Fix the bug')
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'q', account: projectDefault })))
})

test('project folder names the checked-out branch and says there is no isolation', async () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  select('Run in', 'Project folder')
  expect(await screen.findByText('develop')).toBeTruthy()
  expect(screen.getByText(/no isolation/i)).toBeTruthy()
  expect(screen.getByText(/shared with other tasks/i)).toBeTruthy()
})
test('a worktree says where its isolated branch starts', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  expect(screen.getByText(/new branch from/i)).toBeTruthy()
})
test('a quick task runs in a folder, starting at home, with no worktree or project options', async () => {
  mocks.project = { id: 'quick-tasks', name: 'Quick tasks', repoPath: '/Users/me', baseBranch: '', defaultAgentType: 'claude' }
  mocks.inspect.mockResolvedValue({ path: '/Users/me', branch: '', isGit: false })
  render(() => <NewTaskView projectId="quick-tasks" onClose={() => {}} />)
  await screen.findByText('/Users/me')
  fireEvent.click(screen.getByRole('combobox', { name: 'Run in' }))
  expect(screen.queryByRole('option', { name: 'New worktree' })).toBeNull()
  expect(screen.queryByRole('option', { name: 'Project folder' })).toBeNull()
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Find stale branches across repos' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ directory: '/Users/me' })))
})
test('the chat or terminal choice for a Claude task is shown and sent', async () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  expect(screen.getByRole('button', { name: 'Open in chat' }).textContent).toContain('Chat')
  fireEvent.click(screen.getByRole('button', { name: 'Open in terminal' }))
  expect(screen.getByRole('button', { name: 'Open in terminal' }).textContent).toContain('Terminal')
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Fix the bug' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ viewMode: 'terminal' })))
})

// Dictation: the new-task box is a target while it is the box on screen.
const prompt = () => screen.getByRole('textbox', { name: 'Task prompt' }) as HTMLTextAreaElement
const dictationTarget = () => mocks.targets[mocks.targets.length - 1]
test('registers as the dictation target of its project\'s new-task box and unregisters on unmount', () => {
  const { unmount } = render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  expect(mocks.targets.map(t => ({ id: t.id, draftId: t.draftId }))).toEqual([{ id: 'new-task:p', draftId: 'new-task:p' }])
  unmount()
  expect(mocks.targets).toEqual([])
})
test('dictation appends to the prompt without focusing it', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix the' } })
  ;(document.activeElement as HTMLElement | null)?.blur()
  dictationTarget().insert('login bug')
  expect(prompt().value).toBe('Fix the login bug')
  expect(document.activeElement).not.toBe(prompt())
})
test('dictation goes in at the caret when the prompt is focused, and the caret follows it', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix bug' } })
  prompt().focus()
  prompt().setSelectionRange(4, 4)
  dictationTarget().insert('the login')
  expect(prompt().value).toBe('Fix the login bug')
  expect([prompt().selectionStart, prompt().selectionEnd]).toEqual([13, 13])
  expect(draft()).toBe('Fix the login bug')
})
test('a focused take is typed in, so Cmd+Z undoes it', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix bug' } })
  prompt().focus()
  prompt().setSelectionRange(4, 4)
  dictationTarget().insert('the login')
  expect(execCommand).toHaveBeenCalledWith('insertText', false, 'the login ')
})
test('an unfocused take is not typed: that would need focus', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix' } })
  ;(document.activeElement as HTMLElement | null)?.blur()
  dictationTarget().insert('it')
  expect(execCommand).not.toHaveBeenCalled()
  expect(prompt().value).toBe('Fix it')
})
test('hidden behind a selected task or the task board, the new-task box is not a target', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  setSelectedTaskId('t1')
  expect(mocks.targets).toEqual([])
  setSelectedTaskId(null)
  setShowTaskBoard(true)
  expect(mocks.targets).toEqual([])
  setShowTaskBoard(false)
  expect(mocks.targets.map(t => t.id)).toEqual(['new-task:p'])
})
test('the mic is available while the box is a dictation target, not while it sends', async () => {
  let finish!: () => void
  mocks.start.mockReturnValue(new Promise<void>(r => { finish = r }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  const mic = () => screen.getByTestId('dictation').dataset.available
  expect(mic()).toBe('true')
  fireEvent.input(prompt(), { target: { value: 'Fix it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mic()).toBe('false'))
  expect(mocks.targets).toEqual([])
  finish()
})

// The new-task box keeps its prompt as the project's new-task draft, so a take
// for it is never lost while it is hidden, unmounted or sending.
const draft = () => loadDraftMessage(newTaskDraftId('p'))
test('the prompt is kept as the project\'s new-task draft and comes back on remount', () => {
  const { unmount } = render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix it' } })
  expect(draft()).toBe('Fix it')
  unmount()
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  expect(prompt().value).toBe('Fix it')
})
test('each project\'s new-task box has its own draft', () => {
  saveDraftMessage(newTaskDraftId('q'), 'for q')
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  expect(prompt().value).toBe('')
})
test('a take saved for the box while it is hidden shows in its prompt', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix the' } })
  setSelectedTaskId('t1')
  appendToDraft(newTaskDraftId('p'), 'login bug')
  expect(prompt().value).toBe('Fix the login bug')
  expect(draft()).toBe('Fix the login bug')
})
test('a take saved for another project\'s box leaves this prompt alone', () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Mine' } })
  appendToDraft(newTaskDraftId('q'), 'theirs')
  expect(prompt().value).toBe('Mine')
})
test('a take that lands while the task is sent is kept as the project\'s next draft', async () => {
  let finish!: () => void
  mocks.start.mockReturnValue(new Promise<void>(r => { finish = r }))
  const close = vi.fn()
  render(() => <NewTaskView projectId="p" onClose={close} />)
  fireEvent.input(prompt(), { target: { value: 'Fix it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.targets).toEqual([]))
  appendToDraft(newTaskDraftId('p'), 'and the tests')
  expect(prompt().value).toBe('Fix it')
  finish()
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ message: 'Fix it' }))
  expect(draft()).toBe('and the tests')
})
test('a sent task leaves no draft behind', async () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
  await waitFor(() => expect(draft()).toBeNull())
})
test('a take that lands while sending rejoins the prompt when the send fails', async () => {
  let fail!: (e: unknown) => void
  mocks.start.mockReturnValue(new Promise<void>((_, reject) => { fail = reject }))
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.input(prompt(), { target: { value: 'Fix it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.targets).toEqual([]))
  appendToDraft(newTaskDraftId('p'), 'and the tests')
  fail(new Error('nope'))
  await waitFor(() => expect(prompt().value).toBe('Fix it and the tests'))
  expect(draft()).toBe('Fix it and the tests')
})
test('closing the box discards its draft', () => {
  const close = vi.fn()
  render(() => <NewTaskView projectId="p" onClose={close} />)
  fireEvent.input(prompt(), { target: { value: 'Never mind' } })
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }))
  expect(close).toHaveBeenCalledOnce()
  expect(draft()).toBeNull()
})
