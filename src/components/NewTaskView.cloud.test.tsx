import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal, Show } from 'solid-js'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const ipc = vi.hoisted(() => ({
  claudeCloudAvailability: vi.fn(), refreshAgents: vi.fn().mockResolvedValue(undefined),
  getRepoInfo: vi.fn().mockResolvedValue({ branches: ['main'] }),
  beginCloudImport: vi.fn(), cancelCloudImport: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/ipc', () => ipc)
vi.mock('../store/projects', () => ({ projectById: () => ({ repoPath: '/repo', baseBranch: 'main' }), updateProjectDefaultAgentInStore: vi.fn() }))
vi.mock('../store/tasks', () => ({ startTaskCreation: vi.fn(), startCloudTaskImport: vi.fn(), setTasks: vi.fn() }))
vi.mock('../store/sessions', () => ({ setSessions: vi.fn() }))
vi.mock('../store/ui', () => ({ setSelectedTaskId: vi.fn(), setSelectedProjectId: vi.fn(), setSelectedSessionIdForTask: vi.fn(), setShowArchived: vi.fn() }))
vi.mock('../store/agents', () => ({ agents: [] }))
vi.mock('./AgentPicker', () => ({ AgentPicker: () => <div /> }))
vi.mock('../store/draftTask', () => ({ startDraftTask: vi.fn() }))
import { NewTaskView } from './NewTaskView'
const NewTaskDraft = (props: { open: boolean; projectId: string; onClose: () => void }) => <Show when={props.open}><NewTaskView projectId={props.projectId} onClose={props.onClose} /></Show>
afterEach(() => { cleanup(); vi.clearAllMocks() })
beforeEach(() => {
  ipc.claudeCloudAvailability.mockResolvedValue({ available: true, reason: null })
  ipc.beginCloudImport.mockResolvedValue({ importId: 'prefetch', sessions: [{ index: 1, title: 'Notifications', updated: '1d ago' }] })
})
function choose(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label === 'Local' ? 'Write a prompt' : 'Continue from cloud' }))
}
test('opening New Task prefetches cloud sessions and reuses them across source changes', async () => {
  const [open, setOpen] = createSignal(false)
  render(() => <NewTaskDraft open={open()} projectId="project" onClose={() => setOpen(false)} />)
  expect(ipc.beginCloudImport).not.toHaveBeenCalled()
  setOpen(true)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledWith('project'))
  expect(screen.queryByRole('button', { name: /Notifications/ })).toBeNull()
  choose('Claude cloud session')
  await screen.findByRole('button', { name: /Notifications/ })
  choose('Local')
  choose('Claude cloud session')
  expect(ipc.beginCloudImport).toHaveBeenCalledTimes(1)
  expect(ipc.cancelCloudImport).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close draft' }))
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('prefetch'))
})
test('unavailable cloud access does not prefetch', async () => {
  ipc.claudeCloudAvailability.mockResolvedValue({ available: false, reason: 'Sign in first' })
  render(() => <NewTaskDraft open projectId="project" onClose={() => {}} />)
  await waitFor(() => expect(ipc.claudeCloudAvailability).toHaveResolved())
  expect(screen.queryByRole('button', { name: 'Continue from cloud' })).toBeNull()
  expect(ipc.beginCloudImport).not.toHaveBeenCalled()
})
test('checks cloud availability for the selected project', async () => {
  const [project, setProject] = createSignal('p1')
  render(() => <NewTaskDraft open projectId={project()} onClose={() => {}} />)
  await waitFor(() => expect(ipc.claudeCloudAvailability).toHaveBeenCalledWith('p1'))
  setProject('p2')
  await waitFor(() => expect(ipc.claudeCloudAvailability).toHaveBeenCalledWith('p2'))
})
test('a project whose Claude account cannot import falls back to the prompt', async () => {
  // Projects run on their own Claude accounts, so cloud access differs per project.
  ipc.claudeCloudAvailability.mockImplementation(async (projectId: string) => ({ available: projectId === 'first', reason: null }))
  const [project, setProject] = createSignal('first')
  render(() => <NewTaskDraft open projectId={project()} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Continue from cloud' }))
  setProject('second')
  await waitFor(() => expect(ipc.claudeCloudAvailability).toHaveBeenCalledWith('second'))
  await screen.findByRole('textbox', { name: 'Task prompt' })
  expect(screen.queryByRole('button', { name: 'Continue from cloud' })).toBeNull()
  expect(ipc.beginCloudImport).not.toHaveBeenCalledWith('second')
})
test('closing while prefetch is pending cleans up its eventual result', async () => {
  let resolve!: (value: unknown) => void
  ipc.beginCloudImport.mockReturnValue(new Promise(r => { resolve = r }))
  const [open, setOpen] = createSignal(true)
  render(() => <NewTaskDraft open={open()} projectId="project" onClose={() => setOpen(false)} />)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledOnce())
  setOpen(false)
  resolve({ importId: 'late', sessions: [] })
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('late'))
})
test('changing projects disposes the old prefetch and loads the new repository', async () => {
  const [project, setProject] = createSignal('first')
  render(() => <NewTaskDraft open projectId={project()} onClose={() => {}} />)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledWith('first'))
  await waitFor(() => expect(ipc.beginCloudImport).toHaveResolved())
  setProject('second')
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledWith('second'))
  expect(ipc.cancelCloudImport).toHaveBeenCalledWith('prefetch')
})

test('selecting a cloud session closes the draft immediately', async () => {
  const close = vi.fn()
  render(() => <NewTaskDraft open projectId="project" onClose={close} />)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledOnce())
  choose('Claude cloud session')
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  expect(close).toHaveBeenCalledOnce()
})

test('source switch keeps the draft and clearly indicates the active mode', async () => {
  render(() => <NewTaskView projectId="project" onClose={() => {}} />)
  const cloud = await screen.findByRole('button', { name: 'Continue from cloud' })
  fireEvent.input(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Keep my draft' } })
  fireEvent.click(cloud)
  expect(cloud.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('heading', { name: 'Start a task' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Write a prompt' }))
  expect((screen.getByRole('textbox', { name: 'Task prompt' }) as HTMLTextAreaElement).value).toBe('Keep my draft')
  expect(cloud.getAttribute('aria-pressed')).toBe('false')
})
