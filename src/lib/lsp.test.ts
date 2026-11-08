import { describe, test, expect, beforeEach, vi } from 'vitest'

const eventMocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>()
  return {
    listeners,
    fire(name: string, payload: unknown) {
      for (const cb of listeners.get(name) ?? []) cb({ payload })
    },
    listen: (name: string, cb: (event: { payload: unknown }) => void) => {
      const arr = listeners.get(name) ?? []
      arr.push(cb)
      listeners.set(name, arr)
      return Promise.resolve(() => {})
    },
  }
})
vi.mock('@tauri-apps/api/event', () => ({ listen: eventMocks.listen, emit: vi.fn() }))

vi.mock('@codemirror/lsp-client', () => {
  class LSPClient {
    connected = false
    initializing = Promise.resolve()
    constructor(public config: unknown) {}
    connect() { this.connected = true; return this }
    disconnect() { this.connected = false }
    plugin() { return [] }
  }
  class LSPPlugin { static get() { return null } }
  class Workspace { constructor(public client: unknown) {} getFile() { return null } }
  const noop = () => []
  return {
    LSPClient, LSPPlugin, Workspace,
    serverCompletion: noop, signatureHelp: noop, serverDiagnostics: noop,
    formatKeymap: [], renameKeymap: [], jumpToDefinitionKeymap: [], findReferencesKeymap: [],
  }
})

vi.mock('./ipc', () => ({
  lspStart: vi.fn(() => Promise.resolve()),
  lspStop: vi.fn(() => Promise.resolve()),
  lspSend: vi.fn(() => Promise.resolve()),
  tsgoCheckRun: vi.fn(() => Promise.resolve()),
  tsgoCheckCancel: vi.fn(() => Promise.resolve()),
}))
vi.mock('../store/editorView', () => ({ openFilePinned: vi.fn() }))
vi.mock('../store/problems', () => ({ markProblemsLoading: vi.fn(), setProjectErrors: vi.fn() }))
const uiMocks = vi.hoisted(() => ({ windowed: new Set<string>() }))
vi.mock('../store/ui', () => ({
  addToast: vi.fn(),
  isTaskWindowed: (id: string) => uiMocks.windowed.has(id),
}))

import * as ipc from './ipc'
import { getLspClient, stopLspClient } from './lsp'

const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(async () => {
  for (const id of ['a', 'b', 'c', 'd']) await stopLspClient(id)
  uiMocks.windowed.clear()
  vi.clearAllMocks()
})

describe('LSP client lifecycle', () => {
  test('keeps at most two live clients and stops the least recently used', async () => {
    await getLspClient('a', '/w/a')
    await getLspClient('b', '/w/b')
    expect(ipc.lspStop).not.toHaveBeenCalled()

    await getLspClient('c', '/w/c')
    await flush()
    expect(ipc.lspStop).toHaveBeenCalledTimes(1)
    expect(ipc.lspStop).toHaveBeenCalledWith('a')

    // Touching b makes c the least recently used.
    await getLspClient('b', '/w/b')
    await getLspClient('d', '/w/d')
    await flush()
    expect(ipc.lspStop).toHaveBeenLastCalledWith('c')
    expect(ipc.lspStart).toHaveBeenCalledTimes(4)
  })

  test('never evicts a task open in a detached window', async () => {
    uiMocks.windowed.add('a')
    await getLspClient('a', '/w/a')
    await getLspClient('b', '/w/b')
    await getLspClient('c', '/w/c')
    await flush()
    expect(ipc.lspStop).toHaveBeenCalledWith('b')
    expect(ipc.lspStop).not.toHaveBeenCalledWith('a')
  })

  test('concurrent requests for one task start a single server', async () => {
    await Promise.all([getLspClient('a', '/w/a'), getLspClient('a', '/w/a')])
    expect(ipc.lspStart).toHaveBeenCalledTimes(1)
  })

  test('a file-tree change (directory path) schedules a project recheck', async () => {
    vi.useFakeTimers()
    try {
      await getLspClient('a', '/w/a')
      expect(ipc.tsgoCheckRun).toHaveBeenCalledTimes(1)
      eventMocks.fire('file-tree-changed', { taskId: 'a', path: 'src/components' })
      await vi.advanceTimersByTimeAsync(3500)
      expect(ipc.tsgoCheckRun).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
