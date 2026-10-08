import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
const ipc = vi.hoisted(() => ({
  beginCloudImport: vi.fn(), selectCloudImport: vi.fn(), finishCloudImport: vi.fn(),
  cancelCloudImport: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/ipc', () => ipc)
const background = vi.hoisted(() => ({ startCloudTaskImport: vi.fn() }))
vi.mock('../store/tasks', () => background)
import { CloudSessionPicker } from './CloudSessionPicker'
afterEach(() => { cleanup(); vi.clearAllMocks() })
test('one click hands import ownership to the background store and closes immediately', async () => {
  ipc.beginCloudImport.mockResolvedValue({ importId: 'import', sessions: [{ index: 1, title: 'Notifications', updated: '1d ago' }] })
  const started = vi.fn()
  render(() => <CloudSessionPicker projectId="project" onStarted={started} />)
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  expect(background.startCloudTaskImport).toHaveBeenCalledWith('project', 'import', { index: 1, title: 'Notifications', updated: '1d ago' })
  expect(started).toHaveBeenCalledOnce()
  cleanup()
  expect(ipc.cancelCloudImport).not.toHaveBeenCalled()
})
test('late loading result is cleaned up after leaving cloud mode', async () => {
  let resolve!: (value: unknown) => void
  ipc.beginCloudImport.mockReturnValue(new Promise(r => { resolve = r }))
  render(() => <CloudSessionPicker projectId="project" onStarted={() => {}} />)
  cleanup()
  resolve({ importId: 'late', sessions: [] })
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('late'))
})
test('empty list explains how to get a cloud session', async () => {
  ipc.beginCloudImport.mockResolvedValue({ importId: 'empty', sessions: [] })
  render(() => <CloudSessionPicker projectId="project" onStarted={() => {}} />)
  await screen.findByText(/No cloud sessions for this repository/)
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
})
test('session loading explains what is happening without exposing empty actions', () => {
  ipc.beginCloudImport.mockReturnValue(new Promise(() => {}))
  render(() => <CloudSessionPicker projectId="project" onStarted={() => {}} />)
  expect(screen.getByRole('status').textContent).toContain('Finding cloud sessions')
  expect(screen.getByText('Connecting through Claude Code. This can take a few seconds.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
})
