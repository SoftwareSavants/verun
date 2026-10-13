import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
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
afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks(); mocks.start.mockResolvedValue(undefined) })
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

test('the combined picker passes both harness and model into task creation', async () => {
  render(() => <NewTaskView projectId="p" onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
  fireEvent.click(screen.getByRole('button', { name: 'GPT' }))
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Build this' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'codex', model: 'gpt' })))
})
