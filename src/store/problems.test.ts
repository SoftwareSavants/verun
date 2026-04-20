import { describe, test, expect, beforeEach, vi } from 'vitest'

// Mock Tauri event system — we'll call the handler directly
let lspMessageHandler: ((event: any) => void) | null = null
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: any) => {
    if (event === 'lsp-message') lspMessageHandler = handler
    return Promise.resolve(() => {})
  }),
}))

// Mock tasks store — provide a task with a worktree path. Tests that exercise
// the "task deleted mid-check" path flip `deletedTasks` to make taskById
// return undefined for a given taskId.
const deletedTasks = new Set<string>()
vi.mock('./tasks', () => ({
  taskById: vi.fn((id: string) => {
    if (deletedTasks.has(id)) return undefined
    return { id, worktreePath: '/tmp/test-worktree' }
  }),
}))

// Mock lsp module — track which files are "open in editor"
const openEditorFiles = new Set<string>()
vi.mock('../lib/lsp', () => ({
  isFileOpenInEditor: vi.fn((_worktree: string, relativePath: string) =>
    openEditorFiles.has(relativePath)
  ),
  onSyntheticLspMessage: vi.fn(() => () => {}),
}))

import {
  initProblemsListener,
  problemsForTask,
  problemCountForTask,
  problemsByFileForTask,
  fileHasErrors,
  fileHasWarnings,
  problemSeverityForPath,
  clearProblemsForTask,
  setProjectErrors,
} from './problems'

// Helper: simulate an LSP publishDiagnostics message
function emitDiagnostics(taskId: string, uri: string, diagnostics: any[]) {
  const message = JSON.stringify({
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics },
  })
  lspMessageHandler?.({ payload: { taskId, message } })
}

// Helper: flush the requestAnimationFrame batch
function flushBatch() {
  // The store uses requestAnimationFrame for batching — run the queued callback
  vi.runAllTimers()
}

describe('problems store', () => {
  beforeEach(() => {
    clearProblemsForTask('task-1')
    clearProblemsForTask('task-2')
    openEditorFiles.clear()
    deletedTasks.clear()
    vi.useFakeTimers()
    // Mock requestAnimationFrame to use setTimeout(fn, 0) so vi.runAllTimers() works
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
  })

  test('initProblemsListener registers handler', () => {
    initProblemsListener()
    expect(lspMessageHandler).toBeTruthy()
  })

  test('first diagnostics for a task do not crash', () => {
    initProblemsListener()
    // This was the crash scenario: first diagnostic for a task with no prior problems.
    // flushBatch used to set newTaskProblems = undefined, causing a TypeError.
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [
      {
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
        severity: 1,
        message: "Cannot find name 'foobar'",
        code: 2304,
        source: 'typescript',
      },
    ])
    flushBatch()

    const problems = problemsForTask('task-1')
    expect(problems.length).toBe(1)
    expect(problems[0].file).toBe('src/foo.ts')
    expect(problems[0].line).toBe(1)
    expect(problems[0].column).toBe(5)
    expect(problems[0].severity).toBe('error')
    expect(problems[0].message).toBe("Cannot find name 'foobar'")
  })

  test('multiple files in same batch', () => {
    initProblemsListener()

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/a.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error in a', source: 'ts' },
    ])
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/b.ts', [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 2, message: 'Warning in b', source: 'ts' },
    ])
    flushBatch()

    const counts = problemCountForTask('task-1')
    expect(counts.errors).toBe(1)
    expect(counts.warnings).toBe(1)
    expect(fileHasErrors('task-1', 'src/a.ts')).toBe(true)
    expect(fileHasWarnings('task-1', 'src/b.ts')).toBe(true)
  })

  test('remove→add in same batch does not flicker', () => {
    initProblemsListener()

    // Initial diagnostic
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(1)

    // Simulate remove→add cycle (same frame)
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', []) // remove
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [   // add back
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ])
    flushBatch()

    // Should still have the problem (last write wins)
    expect(problemsForTask('task-1').length).toBe(1)
  })

  test('empty diagnostics clears file when open in editor', () => {
    initProblemsListener()
    openEditorFiles.add('src/foo.ts')

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(1)

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(0)
  })

  test('empty diagnostics suppressed for files not open in editor', () => {
    initProblemsListener()

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(1)

    // File not in openEditorFiles → empty diagnostics suppressed (didClose scenario)
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(1) // Still there
  })

  test('skips node_modules diagnostics', () => {
    initProblemsListener()

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/node_modules/foo/index.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(0)
  })

  test('multiple tasks are independent', () => {
    initProblemsListener()

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/a.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error in task 1', source: 'ts' },
    ])
    emitDiagnostics('task-2', 'file:///tmp/test-worktree/src/b.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, message: 'Warning in task 2', source: 'ts' },
    ])
    flushBatch()

    expect(problemCountForTask('task-1')).toEqual({ errors: 1, warnings: 0, info: 0 })
    expect(problemCountForTask('task-2')).toEqual({ errors: 0, warnings: 1, info: 0 })
  })

  test('identical diagnostics are skipped (no unnecessary re-render)', () => {
    initProblemsListener()

    const diag = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ]

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', diag)
    flushBatch()
    const first = problemsByFileForTask('task-1')

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', diag)
    flushBatch()
    const second = problemsByFileForTask('task-1')

    // Same reference means the store didn't update (identical skip worked)
    expect(first).toBe(second)
  })

  test('setProjectErrors replaces all problems for a task atomically', async () => {
    initProblemsListener()
    // Wait for the lsp helpers to load (microtask).
    await Promise.resolve(); await Promise.resolve()

    // Seed two files with errors via the per-file path.
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/a.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'old a', source: 'ts' },
    ])
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/b.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'old b', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(2)

    // Project-wide check returns a fresh set: c.ts has an error, a.ts and
    // b.ts are gone (clean now).
    setProjectErrors('task-1', [
      { file: 'src/c.ts', line: 7, column: 3, severity: 'error', code: 'TS2322', message: 'fresh c' },
    ])

    const after = problemsByFileForTask('task-1')
    expect(Object.keys(after).sort()).toEqual(['src/c.ts'])
    expect(after['src/c.ts'][0].message).toBe('fresh c')
    expect(after['src/c.ts'][0].source).toBe('typescript')
  })

  test('setProjectErrors leaves files open in editor untouched', async () => {
    initProblemsListener()
    await Promise.resolve(); await Promise.resolve()

    openEditorFiles.add('src/owned.ts')
    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/owned.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'lsp owns this', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(1)

    // Project-wide says owned.ts is clean and reports an error in unopened.ts.
    // Editor-owned file should be preserved; unopened should be added.
    setProjectErrors('task-1', [
      { file: 'src/unopened.ts', line: 1, column: 1, severity: 'error', message: 'project error' },
    ])

    const after = problemsByFileForTask('task-1')
    expect(Object.keys(after).sort()).toEqual(['src/owned.ts', 'src/unopened.ts'])
    expect(after['src/owned.ts'][0].message).toBe('lsp owns this')
  })

  test('setProjectErrors drops results for a task that no longer exists', async () => {
    initProblemsListener()
    await Promise.resolve(); await Promise.resolve()

    // Task was deleted between the check being kicked off and the result
    // arriving. setProjectErrors should be a no-op, not re-add the task.
    deletedTasks.add('task-1')
    setProjectErrors('task-1', [
      { file: 'src/foo.ts', line: 1, column: 1, severity: 'error', message: 'stale' },
    ])
    expect(Object.keys(problemsByFileForTask('task-1'))).toEqual([])
  })

  test('setProjectErrors filters node_modules', async () => {
    initProblemsListener()
    await Promise.resolve(); await Promise.resolve()

    setProjectErrors('task-1', [
      { file: 'node_modules/foo/index.ts', line: 1, column: 1, severity: 'error', message: 'noise' },
      { file: 'src/real.ts', line: 1, column: 1, severity: 'error', message: 'real' },
    ])

    const after = problemsByFileForTask('task-1')
    expect(Object.keys(after)).toEqual(['src/real.ts'])
  })

  test('problemSeverityForPath summarizes files and directory prefixes', async () => {
    setProjectErrors('task-1', [
      { file: 'src/a.ts', line: 1, column: 1, severity: 'warning', message: 'warn' },
      { file: 'src/deep/b.ts', line: 1, column: 1, severity: 'error', message: 'err' },
    ])

    expect(problemSeverityForPath('task-1', 'src/a.ts', false)).toBe('warning')
    expect(problemSeverityForPath('task-1', 'src/deep', true)).toBe('error')
    expect(problemSeverityForPath('task-1', 'src', true)).toBe('error')
    expect(problemSeverityForPath('task-1', 'test', true)).toBeNull()
  })

  test('clearProblemsForTask removes all problems', () => {
    initProblemsListener()

    emitDiagnostics('task-1', 'file:///tmp/test-worktree/src/foo.ts', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'Error', source: 'ts' },
    ])
    flushBatch()
    expect(problemsForTask('task-1').length).toBe(1)

    clearProblemsForTask('task-1')
    expect(problemsForTask('task-1').length).toBe(0)
  })
})
