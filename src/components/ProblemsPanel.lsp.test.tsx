import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'

// The Problems panel is what needs project-wide diagnostics, so it (not task
// selection) starts the task's language server — and only once setup is done.
const m = vi.hoisted(() => ({ setupRunning: false }))
vi.mock('../lib/lsp', () => ({ getLspClient: vi.fn(() => Promise.resolve()) }))
vi.mock('../store/tasks', () => ({
  taskById: (id: string) => ({ id, worktreePath: `/work/${id}` }),
}))
vi.mock('../store/setup', () => ({
  isSetupRunning: () => m.setupRunning,
  setupFailed: () => false,
}))

import { ProblemsPanel } from './ProblemsPanel'
import { getLspClient } from '../lib/lsp'

beforeEach(() => {
  cleanup()
  m.setupRunning = false
  vi.mocked(getLspClient).mockClear()
})

describe('<ProblemsPanel /> language server', () => {
  test('starts the LSP for its task, and for the next task when it changes', async () => {
    const [taskId, setTaskId] = createSignal('p1')
    render(() => <ProblemsPanel taskId={taskId()} />)
    await waitFor(() => expect(getLspClient).toHaveBeenCalledWith('p1', '/work/p1'))
    setTaskId('p2')
    await waitFor(() => expect(getLspClient).toHaveBeenCalledWith('p2', '/work/p2'))
  })

  test('waits while setup is running', async () => {
    m.setupRunning = true
    render(() => <ProblemsPanel taskId="p3" />)
    await new Promise(r => setTimeout(r, 20))
    expect(getLspClient).not.toHaveBeenCalled()
  })
})
