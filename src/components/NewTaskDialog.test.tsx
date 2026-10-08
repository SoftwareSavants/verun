import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
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
import { NewTaskDialog } from './NewTaskDialog'
afterEach(() => { cleanup(); vi.clearAllMocks() })
beforeEach(() => {
  ipc.claudeCloudAvailability.mockResolvedValue({ available: true, reason: null })
  ipc.beginCloudImport.mockResolvedValue({ importId: 'prefetch', sessions: [{ index: 1, title: 'Notifications', updated: '1d ago' }] })
})
function choose(label: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'Start from' }))
  fireEvent.click(screen.getByRole('option', { name: label }))
}
test('opening New Task prefetches cloud sessions and reuses them across source changes', async () => {
  const [open, setOpen] = createSignal(false)
  render(() => <NewTaskDialog open={open()} projectId="project" onClose={() => setOpen(false)} />)
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
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('prefetch'))
})
test('unavailable cloud access does not prefetch', async () => {
  ipc.claudeCloudAvailability.mockResolvedValue({ available: false, reason: 'Sign in first' })
  render(() => <NewTaskDialog open projectId="project" onClose={() => {}} />)
  await screen.findByText('Sign in first')
  expect(ipc.beginCloudImport).not.toHaveBeenCalled()
})
test('closing while prefetch is pending cleans up its eventual result', async () => {
  let resolve!: (value: unknown) => void
  ipc.beginCloudImport.mockReturnValue(new Promise(r => { resolve = r }))
  const [open, setOpen] = createSignal(true)
  render(() => <NewTaskDialog open={open()} projectId="project" onClose={() => setOpen(false)} />)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledOnce())
  setOpen(false)
  resolve({ importId: 'late', sessions: [] })
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('late'))
})
test('changing projects disposes the old prefetch and loads the new repository', async () => {
  const [project, setProject] = createSignal('first')
  render(() => <NewTaskDialog open projectId={project()} onClose={() => {}} />)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledWith('first'))
  await waitFor(() => expect(ipc.beginCloudImport).toHaveResolved())
  setProject('second')
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledWith('second'))
  expect(ipc.cancelCloudImport).toHaveBeenCalledWith('prefetch')
})

test('selecting a cloud session closes the dialog immediately', async () => {
  const close = vi.fn()
  render(() => <NewTaskDialog open projectId="project" onClose={close} />)
  await waitFor(() => expect(ipc.beginCloudImport).toHaveBeenCalledOnce())
  choose('Claude cloud session')
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  expect(close).toHaveBeenCalledOnce()
})
