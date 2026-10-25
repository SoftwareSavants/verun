import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ start: vi.fn(), open: vi.fn(), inspect: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('../lib/ipc', () => ({
  getRepoInfo: vi.fn().mockResolvedValue({ branches: ['main', 'develop'] }),
  refreshAgents: vi.fn().mockResolvedValue(undefined),
  claudeCloudAvailability: vi.fn().mockResolvedValue({ available: false, reason: null }),
  inspectTaskDirectory: mocks.inspect,
}))
vi.mock('../store/projects', () => ({ projectById: () => ({ id: 'p', name: 'Project', repoPath: '/repo', baseBranch: 'main', defaultAgentType: 'claude' }) }))
vi.mock('../store/agents', () => ({ agents: [{ id: 'claude', name: 'Claude Code', installed: true, supportsModelSelection: true, models: [{ id: 'opus', label: 'Opus', description: '' }] }, { id: 'codex', name: 'Codex', installed: true, supportsModelSelection: true, models: [{ id: 'gpt', label: 'GPT', description: '' }] }] }))
vi.mock('../store/draftTask', () => ({ startDraftTask: mocks.start }))
vi.mock('./AgentPicker', () => ({ AgentPicker: () => <span>Claude</span> }))
vi.mock('./CloudSessionPicker', () => ({ CloudSessionPicker: () => null }))
import { NewTaskView } from './NewTaskView'
import { toasts, setToasts } from '../store/ui'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeSnapshot } from '../test/accountFixtures'
afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); setToasts([]); applySnapshot(makeSnapshot()); mocks.start.mockResolvedValue(undefined) })
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
