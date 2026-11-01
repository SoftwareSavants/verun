import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ resolveTerminalFile: vi.fn(), openFilePinned: vi.fn(), setPendingGoToLine: vi.fn(), addToast: vi.fn() }))
vi.mock('./ipc', () => ({ resolveTerminalFile: mocks.resolveTerminalFile }))
vi.mock('../store/editorView', () => ({ openFilePinned: mocks.openFilePinned, setPendingGoToLine: mocks.setPendingGoToLine }))
vi.mock('../store/ui', () => ({ addToast: mocks.addToast }))
import { openTerminalFile } from './openTerminalFile'
test('opens resolved file and requests its editor location', async () => {
  mocks.resolveTerminalFile.mockResolvedValue({ taskId: 't1', relativePath: 'src/a.ts' })
  await openTerminalFile('pty1', { path: './a.ts', line: 5, column: 3, start: 0, end: 6 })
  expect(mocks.resolveTerminalFile).toHaveBeenCalledWith('pty1', './a.ts')
  expect(mocks.openFilePinned).toHaveBeenCalledWith('t1', 'src/a.ts', 'a.ts')
  expect(mocks.setPendingGoToLine).toHaveBeenCalledWith({ taskId: 't1', relativePath: 'src/a.ts', line: 5, column: 3 })
})
test('missing file shows an error without opening an editor', async () => {
  mocks.openFilePinned.mockClear()
  mocks.resolveTerminalFile.mockRejectedValue('File not found: missing.ts')
  await openTerminalFile('pty1', { path: 'missing.ts', line: 1, column: 1, start: 0, end: 10 })
  expect(mocks.openFilePinned).not.toHaveBeenCalled()
  expect(mocks.addToast).toHaveBeenCalledWith('File not found: missing.ts', 'error')
})
test('opens an external file in a pinned tab without prepending the workspace', async () => {
  mocks.resolveTerminalFile.mockResolvedValue({ taskId: 't1', relativePath: '/private/tmp/notes.txt' })
  await openTerminalFile('pty1', { path: '/private/tmp/notes.txt', line: 7, column: 1, start: 0, end: 22 })
  expect(mocks.openFilePinned).toHaveBeenCalledWith('t1', '/private/tmp/notes.txt', 'notes.txt')
  expect(mocks.setPendingGoToLine).toHaveBeenCalledWith({ taskId: 't1', relativePath: '/private/tmp/notes.txt', line: 7, column: 1 })
})
