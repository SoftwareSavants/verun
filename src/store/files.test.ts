import { describe, test, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/ipc', () => ({
  listDirectory: vi.fn().mockResolvedValue([]),
}))

import { loadDirectory, loadDirectoryIfMissing, clearTaskFileCache, getDirContents, reloadAllCachedDirectoriesForTask, diffTabKey, pathFromDiffKey } from './files'
import * as ipc from '../lib/ipc'

describe('diffTabKey', () => {
  test('working', () => {
    expect(diffTabKey({ type: 'working' }, 'src/foo.ts')).toBe('__diff__:working:src/foo.ts')
  })
  test('staged', () => {
    expect(diffTabKey({ type: 'staged' }, 'src/foo.ts')).toBe('__diff__:staged:src/foo.ts')
  })
  test('unstaged', () => {
    expect(diffTabKey({ type: 'unstaged' }, 'src/foo.ts')).toBe('__diff__:unstaged:src/foo.ts')
  })
  test('commit', () => {
    expect(diffTabKey({ type: 'commit', commitHash: 'abc1234' }, 'src/foo.ts')).toBe('__diff__:commit:abc1234:src/foo.ts')
  })
})

describe('pathFromDiffKey', () => {
  test('working key round-trips', () => {
    const key = diffTabKey({ type: 'working' }, 'src/foo.ts')
    expect(pathFromDiffKey(key)).toBe('src/foo.ts')
  })
  test('staged key round-trips', () => {
    const key = diffTabKey({ type: 'staged' }, 'src/foo.ts')
    expect(pathFromDiffKey(key)).toBe('src/foo.ts')
  })
  test('unstaged key round-trips', () => {
    const key = diffTabKey({ type: 'unstaged' }, 'src/foo.ts')
    expect(pathFromDiffKey(key)).toBe('src/foo.ts')
  })
  test('commit key round-trips', () => {
    const key = diffTabKey({ type: 'commit', commitHash: 'abc1234' }, 'src/foo.ts')
    expect(pathFromDiffKey(key)).toBe('src/foo.ts')
  })
  test('unknown key returns null', () => {
    expect(pathFromDiffKey('unknown:key')).toBeNull()
  })
})

describe('loadDirectoryIfMissing', () => {
  beforeEach(() => {
    vi.mocked(ipc.listDirectory).mockReset()
    vi.mocked(ipc.listDirectory).mockResolvedValue([
      { name: 'src', relativePath: 'src', isDir: true, isSymlink: false, size: null, isGitignored: false },
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

describe('reloadAllCachedDirectoriesForTask', () => {
  beforeEach(() => {
    vi.mocked(ipc.listDirectory).mockReset()
    vi.mocked(ipc.listDirectory).mockResolvedValue([])
  })

  test('refetches list_directory for each cached path of that task', async () => {
    await loadDirectory('t-multi', '')
    await loadDirectory('t-multi', 'src')
    vi.mocked(ipc.listDirectory).mockClear()
    reloadAllCachedDirectoriesForTask('t-multi')
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledTimes(2)
    })
    expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledWith('t-multi', '')
    expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledWith('t-multi', 'src')
  })

  test('does not touch other tasks', async () => {
    await loadDirectory('t-a', '')
    await loadDirectory('t-b', 'x')
    vi.mocked(ipc.listDirectory).mockClear()
    reloadAllCachedDirectoriesForTask('t-a')
    await vi.waitFor(() => expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(ipc.listDirectory)).toHaveBeenCalledWith('t-a', '')
  })
})
