import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  beginCloudImport: vi.fn().mockResolvedValue({ importId: 'import', terminalId: 'pty' }),
  finishCloudImport: vi.fn(),
  cancelCloudImport: vi.fn().mockResolvedValue(undefined),
}))
const terminals = vi.hoisted(() => ({ closeTerminal: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../store/terminals', () => terminals)
vi.mock('../lib/ipc', () => ipc)
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('./ShellTerminal', () => ({ ShellTerminal: () => <div>Cloud picker</div> }))
import { CloudImportDialog } from './CloudImportDialog'

afterEach(() => { cleanup(); vi.clearAllMocks() })

test('failed preparation keeps the import retryable and never publishes a task', async () => {
  ipc.finishCloudImport.mockRejectedValueOnce(new Error('Branch could not be verified'))
  const ready = vi.fn()
  render(() => <CloudImportDialog projectId="project" onClose={() => {}} onReady={ready} />)
  await screen.findByText('Cloud picker')
  fireEvent.click(screen.getByRole('button', { name: 'Continue locally' }))
  await screen.findByText(/Branch could not be verified/)
  expect(ready).not.toHaveBeenCalled()
  const result = { task: { id: 'task' }, session: { id: 'session' } }
  ipc.finishCloudImport.mockResolvedValueOnce(result)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(ready).toHaveBeenCalledWith(result))
  expect(ipc.beginCloudImport).toHaveBeenCalledTimes(1)
})

test('cancelling closes and removes the unpublished import', async () => {
  const close = vi.fn()
  render(() => <CloudImportDialog projectId="project" onClose={close} onReady={() => {}} />)
  await screen.findByText('Cloud picker')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(ipc.cancelCloudImport).toHaveBeenCalledWith('import'))
  expect(close).toHaveBeenCalledOnce()
  cleanup()
  await waitFor(() => expect(terminals.closeTerminal).toHaveBeenCalledWith('pty'))
})
