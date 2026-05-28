import { describe, test, expect, beforeEach, vi } from 'vitest'

const eventMocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: any }) => unknown>()
  return {
    listeners,
    listen: vi.fn(async (name: string, cb: (event: { payload: any }) => unknown) => {
      listeners.set(name, cb)
      return () => listeners.delete(name)
    }),
  }
})

vi.mock('@tauri-apps/api/event', () => eventMocks)

const editorMocks = vi.hoisted(() => {
  type Tab = { relativePath: string; name: string; dirty: boolean; preview: boolean }
  let tabs: Record<string, Tab[]> = {}
  return {
    allOpenTabs: () => tabs,
    setTabDirty: vi.fn(),
    __setOpenTabs: (next: Record<string, Tab[]>) => {
      tabs = next
    },
  }
})

vi.mock('./editorView', () => editorMocks)

const uiMocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  dismissToast: vi.fn(),
}))

vi.mock('./ui', () => uiMocks)

vi.mock('../lib/ipc', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  getTask: vi.fn(),
}))

import {
  activeConflict,
  activeRecreate,
  checkBeforeSave,
  dismissConflict,
  dismissRecreate,
  initOpenFilesRefresh,
  isFileDeleted,
  reloadNonce,
  requestRecreate,
  resolveRecreate,
} from './fileSync'
import {
  getCachedContent,
  getCachedOriginal,
  setCachedContent,
  setCachedOriginal,
} from './files'
import * as ipc from '../lib/ipc'

function resetAllMocks() {
  vi.mocked(ipc.readTextFile).mockReset()
  vi.mocked(ipc.writeTextFile).mockReset()
  vi.mocked(ipc.getTask).mockReset()
  uiMocks.addToast.mockReset()
  uiMocks.dismissToast.mockReset()
  editorMocks.__setOpenTabs({})
  editorMocks.setTabDirty.mockReset()
  dismissConflict()
  dismissRecreate()
}

describe('checkBeforeSave', () => {
  beforeEach(resetAllMocks)

  test('silently reloads when disk diverged but user has no local edits', async () => {
    const taskId = 't-no-edits'
    const relPath = 'src/foo.ts'
    const original = 'export const x = 1'
    const externalEdit = 'export const x = 2'

    setCachedOriginal(taskId, relPath, original)
    setCachedContent(taskId, relPath, original)

    vi.mocked(ipc.readTextFile).mockResolvedValueOnce(externalEdit)

    const nonceBefore = reloadNonce(taskId, relPath)
    // currentContent === cachedOriginal means the user did not edit anything
    const ok = await checkBeforeSave(taskId, relPath, '/worktree', original)

    expect(activeConflict()).toBeNull()
    expect(ok).toBe(false)
    expect(getCachedOriginal(taskId, relPath)).toBe(externalEdit)
    expect(getCachedContent(taskId, relPath)).toBe(externalEdit)
    expect(reloadNonce(taskId, relPath)).toBe(nonceBefore + 1)
  })

  test('returns true when disk matches cached original', async () => {
    const taskId = 't-clean-disk'
    const relPath = 'src/bar.ts'
    const original = 'const y = 1'

    setCachedOriginal(taskId, relPath, original)
    vi.mocked(ipc.readTextFile).mockResolvedValueOnce(original)

    const ok = await checkBeforeSave(taskId, relPath, '/worktree', 'const y = 2')
    expect(ok).toBe(true)
    expect(activeConflict()).toBeNull()
  })

  test('returns true when disk happens to match what user is about to write', async () => {
    const taskId = 't-converge'
    const relPath = 'src/baz.ts'
    const original = 'const z = 1'
    const converged = 'const z = 2'

    setCachedOriginal(taskId, relPath, original)
    vi.mocked(ipc.readTextFile).mockResolvedValueOnce(converged)

    const ok = await checkBeforeSave(taskId, relPath, '/worktree', converged)
    expect(ok).toBe(true)
    expect(activeConflict()).toBeNull()
    expect(getCachedOriginal(taskId, relPath)).toBe(converged)
  })

  test('opens conflict dialog when both sides diverged', async () => {
    const taskId = 't-three-way'
    const relPath = 'src/qux.ts'
    const original = 'const q = 1'
    const userEdit = 'const q = 2'
    const externalEdit = 'const q = 3'

    setCachedOriginal(taskId, relPath, original)
    vi.mocked(ipc.readTextFile).mockResolvedValueOnce(externalEdit)

    const ok = await checkBeforeSave(taskId, relPath, '/worktree', userEdit)
    expect(ok).toBe(false)
    expect(activeConflict()).toEqual({
      taskId,
      relativePath: relPath,
      diskContent: externalEdit,
      verunContent: userEdit,
    })
  })

  test('returns true when file was never loaded', async () => {
    const ok = await checkBeforeSave('t-unloaded', 'src/new.ts', '/worktree', 'any content')
    expect(ok).toBe(true)
    expect(activeConflict()).toBeNull()
    expect(vi.mocked(ipc.readTextFile)).not.toHaveBeenCalled()
  })

  test('returns true when disk read throws', async () => {
    const taskId = 't-read-fail'
    const relPath = 'src/unreadable.ts'
    setCachedOriginal(taskId, relPath, 'whatever')
    vi.mocked(ipc.readTextFile).mockRejectedValueOnce(new Error('EACCES'))

    const ok = await checkBeforeSave(taskId, relPath, '/worktree', 'whatever')
    expect(ok).toBe(true)
    expect(activeConflict()).toBeNull()
  })
})

describe('file-tree-changed listener', () => {
  beforeEach(() => {
    resetAllMocks()
    // Cannot remove listeners between tests (initOpenFilesRefresh is idempotent),
    // but the test exercises the registered listener directly via the mock map.
  })

  test('refreshes a clean tab silently when disk diverged', async () => {
    const taskId = 't-watch-clean'
    const relPath = 'src/clean.ts'
    setCachedOriginal(taskId, relPath, 'old')
    setCachedContent(taskId, relPath, 'old')

    editorMocks.__setOpenTabs({
      [taskId]: [{ relativePath: relPath, name: 'clean.ts', dirty: false, preview: false }],
    })
    vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
    vi.mocked(ipc.readTextFile).mockResolvedValue('new')

    await initOpenFilesRefresh()
    const nonceBefore = reloadNonce(taskId, relPath)

    const handler = eventMocks.listeners.get('file-tree-changed')
    expect(handler).toBeDefined()
    await handler?.({ payload: { taskId, path: 'src' } })

    expect(getCachedOriginal(taskId, relPath)).toBe('new')
    expect(getCachedContent(taskId, relPath)).toBe('new')
    expect(reloadNonce(taskId, relPath)).toBe(nonceBefore + 1)
    expect(uiMocks.addToast).not.toHaveBeenCalled()
  })

  test('toasts a dirty tab when disk diverged', async () => {
    const taskId = 't-watch-dirty'
    const relPath = 'src/dirty.ts'
    setCachedOriginal(taskId, relPath, 'old')
    setCachedContent(taskId, relPath, 'user edits')

    editorMocks.__setOpenTabs({
      [taskId]: [{ relativePath: relPath, name: 'dirty.ts', dirty: true, preview: false }],
    })
    vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
    vi.mocked(ipc.readTextFile).mockResolvedValue('external edit')

    await initOpenFilesRefresh()
    const nonceBefore = reloadNonce(taskId, relPath)

    await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })

    // Cached original is intentionally NOT updated — we still need it as a baseline
    expect(getCachedOriginal(taskId, relPath)).toBe('old')
    expect(getCachedContent(taskId, relPath)).toBe('user edits')
    expect(reloadNonce(taskId, relPath)).toBe(nonceBefore)
    expect(uiMocks.addToast).toHaveBeenCalledTimes(1)
  })

  test('ignores events for other tasks', async () => {
    const ownTask = 't-own'
    const otherTask = 't-other'
    const relPath = 'src/foo.ts'
    setCachedOriginal(ownTask, relPath, 'own original')
    setCachedContent(ownTask, relPath, 'own original')

    editorMocks.__setOpenTabs({
      [ownTask]: [{ relativePath: relPath, name: 'foo.ts', dirty: false, preview: false }],
    })
    vi.mocked(ipc.getTask).mockResolvedValue({ id: ownTask, worktreePath: '/wt' } as any)
    vi.mocked(ipc.readTextFile).mockResolvedValue('different on disk')

    await initOpenFilesRefresh()
    const nonceBefore = reloadNonce(ownTask, relPath)

    await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId: otherTask, path: 'src' } })

    expect(getCachedOriginal(ownTask, relPath)).toBe('own original')
    expect(reloadNonce(ownTask, relPath)).toBe(nonceBefore)
    expect(vi.mocked(ipc.readTextFile)).not.toHaveBeenCalled()
  })

  test('skips events flagged ignoreRulesChanged (gitignore-only changes)', async () => {
    const taskId = 't-ignore-rules'
    const relPath = 'src/foo.ts'
    setCachedOriginal(taskId, relPath, 'orig')
    setCachedContent(taskId, relPath, 'orig')

    editorMocks.__setOpenTabs({
      [taskId]: [{ relativePath: relPath, name: 'foo.ts', dirty: false, preview: false }],
    })

    await initOpenFilesRefresh()
    await eventMocks.listeners.get('file-tree-changed')?.({
      payload: { taskId, path: '', ignoreRulesChanged: true },
    })

    expect(vi.mocked(ipc.readTextFile)).not.toHaveBeenCalled()
  })

  test('per-file filter only re-checks the named tab', async () => {
    const taskId = 't-per-file'
    const targetPath = 'src/target.ts'
    const otherPath = 'src/other.ts'
    setCachedOriginal(taskId, targetPath, 'target-orig')
    setCachedContent(taskId, targetPath, 'target-orig')
    setCachedOriginal(taskId, otherPath, 'other-orig')
    setCachedContent(taskId, otherPath, 'other-orig')

    editorMocks.__setOpenTabs({
      [taskId]: [
        { relativePath: targetPath, name: 'target.ts', dirty: false, preview: false },
        { relativePath: otherPath, name: 'other.ts', dirty: false, preview: false },
      ],
    })
    vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
    vi.mocked(ipc.readTextFile).mockResolvedValue('target-fresh')

    await initOpenFilesRefresh()
    const { checkOpenFilesForExternalChanges } = await import('./fileSync')
    await checkOpenFilesForExternalChanges(taskId, targetPath)

    expect(vi.mocked(ipc.readTextFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ipc.readTextFile)).toHaveBeenCalledWith('/wt/src/target.ts')
    expect(getCachedOriginal(taskId, targetPath)).toBe('target-fresh')
    expect(getCachedOriginal(taskId, otherPath)).toBe('other-orig')
  })

  test('marks tab as deleted when disk read returns NotFound (after debounce)', async () => {
    vi.useFakeTimers()
    try {
      const taskId = 't-del'
      const relPath = 'src/del.ts'
      setCachedOriginal(taskId, relPath, 'orig')
      setCachedContent(taskId, relPath, 'orig')

      editorMocks.__setOpenTabs({
        [taskId]: [{ relativePath: relPath, name: 'del.ts', dirty: false, preview: false }],
      })
      vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
      vi.mocked(ipc.readTextFile).mockRejectedValue(new Error(`NotFound: ${relPath}`))

      expect(isFileDeleted(taskId, relPath)).toBe(false)

      await initOpenFilesRefresh()
      await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })

      // Not marked yet — debounce window protects against atomic-write false positives
      expect(isFileDeleted(taskId, relPath)).toBe(false)

      await vi.advanceTimersByTimeAsync(300)
      expect(isFileDeleted(taskId, relPath)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('does NOT mark deleted when file reappears within the atomic-write debounce window', async () => {
    vi.useFakeTimers()
    try {
      const taskId = 't-atomic'
      const relPath = 'src/atomic.ts'
      setCachedOriginal(taskId, relPath, 'orig')
      setCachedContent(taskId, relPath, 'orig')

      editorMocks.__setOpenTabs({
        [taskId]: [{ relativePath: relPath, name: 'atomic.ts', dirty: false, preview: false }],
      })
      vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
      // First read: NotFound (transient mid-rename)
      // Second read (re-confirmation): file is back with new content
      vi.mocked(ipc.readTextFile)
        .mockRejectedValueOnce(new Error(`NotFound: ${relPath}`))
        .mockResolvedValueOnce('atomic-write-result')
        .mockResolvedValueOnce('atomic-write-result')

      await initOpenFilesRefresh()
      await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })

      expect(isFileDeleted(taskId, relPath)).toBe(false)

      await vi.advanceTimersByTimeAsync(300)
      expect(isFileDeleted(taskId, relPath)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('requestRecreate populates activeRecreate; resolveRecreate writes, clears deleted state, bumps nonce', async () => {
    vi.useFakeTimers()
    try {
      const taskId = 't-recreate'
      const relPath = 'src/recreate.ts'
      const content = 'export const restored = true'

      setCachedOriginal(taskId, relPath, 'orig')
      setCachedContent(taskId, relPath, 'orig')
      editorMocks.__setOpenTabs({
        [taskId]: [{ relativePath: relPath, name: 'recreate.ts', dirty: false, preview: false }],
      })
      vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
      vi.mocked(ipc.readTextFile)
        .mockRejectedValueOnce(new Error(`NotFound: ${relPath}`))
        .mockRejectedValueOnce(new Error(`NotFound: ${relPath}`))

      await initOpenFilesRefresh()
      await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })
      await vi.advanceTimersByTimeAsync(300)
      expect(isFileDeleted(taskId, relPath)).toBe(true)

      requestRecreate(taskId, relPath, content)
      expect(activeRecreate()).toEqual({ taskId, relativePath: relPath, content })

      const nonceBefore = reloadNonce(taskId, relPath)
      vi.mocked(ipc.writeTextFile).mockResolvedValue(undefined as any)
      await resolveRecreate({ taskId, relativePath: relPath, content })

      expect(vi.mocked(ipc.writeTextFile)).toHaveBeenCalledWith(taskId, relPath, content)
      expect(isFileDeleted(taskId, relPath)).toBe(false)
      expect(activeRecreate()).toBeNull()
      expect(getCachedOriginal(taskId, relPath)).toBe(content)
      expect(getCachedContent(taskId, relPath)).toBe(content)
      expect(reloadNonce(taskId, relPath)).toBe(nonceBefore + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('dismissRecreate clears activeRecreate without writing', async () => {
    const taskId = 't-recreate-cancel'
    const relPath = 'src/cancel.ts'

    requestRecreate(taskId, relPath, 'buffer')
    expect(activeRecreate()).not.toBeNull()

    dismissRecreate()
    expect(activeRecreate()).toBeNull()
    expect(vi.mocked(ipc.writeTextFile)).not.toHaveBeenCalled()
  })

  test('clears deleted state when the file reappears on disk', async () => {
    vi.useFakeTimers()
    try {
      const taskId = 't-undel'
      const relPath = 'src/undel.ts'
      setCachedOriginal(taskId, relPath, 'orig')
      setCachedContent(taskId, relPath, 'orig')

      editorMocks.__setOpenTabs({
        [taskId]: [{ relativePath: relPath, name: 'undel.ts', dirty: false, preview: false }],
      })
      vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
      // First sweep: read fails, then the debounced re-confirmation also fails (true delete)
      vi.mocked(ipc.readTextFile)
        .mockRejectedValueOnce(new Error(`NotFound: ${relPath}`))
        .mockRejectedValueOnce(new Error(`NotFound: ${relPath}`))

      await initOpenFilesRefresh()
      await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })
      await vi.advanceTimersByTimeAsync(300)
      expect(isFileDeleted(taskId, relPath)).toBe(true)

      // File comes back externally — next read succeeds
      vi.mocked(ipc.readTextFile).mockResolvedValueOnce('back from the dead')
      await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })

      expect(isFileDeleted(taskId, relPath)).toBe(false)
      expect(getCachedOriginal(taskId, relPath)).toBe('back from the dead')
    } finally {
      vi.useRealTimers()
    }
  })

  test('dirty-tab toast uses Conflicting changes copy and Cancel/Take disk/Keep mine actions', async () => {
    const taskId = 't-toast-copy'
    const relPath = 'src/dirty-copy.ts'
    setCachedOriginal(taskId, relPath, 'orig')
    setCachedContent(taskId, relPath, 'user edits')

    editorMocks.__setOpenTabs({
      [taskId]: [{ relativePath: relPath, name: 'dirty-copy.ts', dirty: true, preview: false }],
    })
    vi.mocked(ipc.getTask).mockResolvedValue({ id: taskId, worktreePath: '/wt' } as any)
    vi.mocked(ipc.readTextFile).mockResolvedValue('disk diverged')

    await initOpenFilesRefresh()
    await eventMocks.listeners.get('file-tree-changed')?.({ payload: { taskId, path: 'src' } })

    expect(uiMocks.addToast).toHaveBeenCalledTimes(1)
    const [message, type, opts] = uiMocks.addToast.mock.calls[0]
    expect(message).toBe('Conflicting changes')
    expect(type).toBe('info')
    expect(opts).toMatchObject({
      description: 'dirty-copy.ts was edited both in Verun and on disk. Choose which version to keep.',
      persistent: true,
    })
    const labels = (opts?.actions ?? []).map((a: { label: string }) => a.label)
    const variants = (opts?.actions ?? []).map((a: { variant?: string }) => a.variant)
    expect(labels).toEqual(['Cancel', 'Take disk', 'Keep mine'])
    expect(variants).toEqual(['ghost', 'danger', 'primary'])
  })
})
