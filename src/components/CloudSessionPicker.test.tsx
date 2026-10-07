import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
const ipc = vi.hoisted(() => ({
  beginCloudImport: vi.fn(), selectCloudImport: vi.fn(), finishCloudImport: vi.fn(),
  cancelCloudImport: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/ipc', () => ipc)
import { CloudSessionPicker } from './CloudSessionPicker'
afterEach(() => { cleanup(); vi.clearAllMocks() })
test('one click selects and finishes the cloud import', async () => {
  ipc.beginCloudImport.mockResolvedValue({ importId: 'import', sessions: [{ index: 1, title: 'Notifications', updated: '1d ago' }] })
  ipc.selectCloudImport.mockResolvedValue(undefined)
  const result = { task: { id: 'task' }, session: { id: 'session' } }
  ipc.finishCloudImport.mockResolvedValue(result)
  const ready = vi.fn()
  render(() => <CloudSessionPicker projectId="project" onReady={ready} />)
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  await waitFor(() => expect(ready).toHaveBeenCalledWith(result))
  expect(ipc.selectCloudImport).toHaveBeenCalledWith('project', 'import', 1)
  expect(ipc.finishCloudImport).toHaveBeenCalledWith('project', 'import')
  cleanup()
  expect(ipc.cancelCloudImport).not.toHaveBeenCalled()
})
test('late loading result is cleaned up after leaving cloud mode', async () => {
  let resolve!: (value: unknown) => void
  ipc.beginCloudImport.mockReturnValue(new Promise(r => { resolve = r }))
  render(() => <CloudSessionPicker projectId="project" onReady={() => {}} />)
  cleanup()
  resolve({ importId: 'late', sessions: [] })
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('late'))
})
test('empty list explains how to get a cloud session', async () => {
  ipc.beginCloudImport.mockResolvedValue({ importId: 'empty', sessions: [] })
  render(() => <CloudSessionPicker projectId="project" onReady={() => {}} />)
  await screen.findByText(/No cloud sessions for this repository/)
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
})
test('failed finalization can retry without teleporting twice', async () => {
  ipc.beginCloudImport.mockResolvedValue({ importId: 'retry', sessions: [{ index: 1, title: 'Notifications', updated: '1d ago' }] })
  ipc.selectCloudImport.mockResolvedValue(undefined)
  ipc.finishCloudImport.mockRejectedValueOnce(new Error('Disk full')).mockResolvedValueOnce({ task: {}, session: {} })
  const ready = vi.fn()
  render(() => <CloudSessionPicker projectId="project" onReady={ready} />)
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry import' }))
  await waitFor(() => expect(ready).toHaveBeenCalledOnce())
  expect(ipc.selectCloudImport).toHaveBeenCalledTimes(1)
})
test('import keeps the selected title visible and shows completed and current steps', async () => {
  ipc.beginCloudImport.mockResolvedValue({ importId: 'progress', sessions: [{ index: 1, title: 'Notifications', updated: '1d ago' }] })
  let imported!: () => void
  ipc.selectCloudImport.mockReturnValue(new Promise<void>(r => { imported = r }))
  ipc.finishCloudImport.mockReturnValue(new Promise(() => {}))
  render(() => <CloudSessionPicker projectId="project" onReady={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  expect(screen.getByText('Notifications')).toBeTruthy()
  expect(screen.getByText('Import conversation and code').closest('li')?.getAttribute('aria-current')).toBe('step')
  imported()
  await waitFor(() => expect(screen.getByText('Create local task').closest('li')?.getAttribute('aria-current')).toBe('step'))
  expect(screen.getByLabelText('Import conversation and code complete')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
})
test('session loading explains what is happening without exposing empty actions', () => {
  ipc.beginCloudImport.mockReturnValue(new Promise(() => {}))
  render(() => <CloudSessionPicker projectId="project" onReady={() => {}} />)
  expect(screen.getByRole('status').textContent).toContain('Finding cloud sessions')
  expect(screen.getByText('Connecting through Claude Code. This can take a few seconds.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
})
