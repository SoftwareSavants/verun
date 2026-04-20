import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/ipc', () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
}))

import { loadDirectory, loadDirectoryIfMissing, clearTaskFileCache, getDirContents } from './files'
import * as ipc from '../lib/ipc'

describe('loadDirectoryIfMissing', () => {
  beforeEach(() => {
    vi.mocked(ipc.listDirectory).mockReset()
    vi.mocked(ipc.listDirectory).mockResolvedValue([
      { name: 'src', relativePath: 'src', isDir: true, isSymlink: false, size: null },
    ])
  })

  test('loads on first call', async () => {
    await loadDirectoryIfMissing('t-first', '')
    expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledTimes(1)
    expect(getDirContents('t-first', '')).toBeDefined()
  })

  test('skips the IPC when contents are already cached', async () => {
    await loadDirectory('t-hit', '')
    await loadDirectoryIfMissing('t-hit', '')
    expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledTimes(1)
  })

  test('reloads after clearTaskFileCache invalidates the entry', async () => {
    await loadDirectory('t-clear', '')
    clearTaskFileCache('t-clear')
    await loadDirectoryIfMissing('t-clear', '')
    expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledTimes(2)
  })
})
