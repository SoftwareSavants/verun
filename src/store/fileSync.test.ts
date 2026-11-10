import { describe, test, expect, vi, beforeEach } from 'vitest'

const handlers: Record<string, (e: { payload: unknown }) => void> = {}
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, h: (e: { payload: unknown }) => void) => { handlers[name] = h; return Promise.resolve(() => {}) }),
}))
const disk: Record<string, string> = {}
vi.mock('../lib/ipc', () => ({
  getTask: vi.fn(async (id: string) => ({ id, worktreePath: '/wt' })),
  readTextFile: vi.fn(async (p: string) => {
    if (!(p in disk)) throw new Error('missing')
    return disk[p]
  }),
}))
const tabs: Record<string, { relativePath: string; name: string; dirty: boolean }[]> = {}
vi.mock('./editorView', () => ({ allOpenTabs: () => tabs, setTabDirty: vi.fn() }))
const content = new Map<string, string>()
const original = new Map<string, string>()
vi.mock('./files', () => ({
  getCachedContent: (t: string, p: string) => content.get(`${t}:${p}`),
  getCachedOriginal: (t: string, p: string) => original.get(`${t}:${p}`),
  setCachedContent: (t: string, p: string, v: string) => content.set(`${t}:${p}`, v),
  setCachedOriginal: (t: string, p: string, v: string) => original.set(`${t}:${p}`, v),
}))
vi.mock('./ui', () => ({ addToast: vi.fn(), dismissToast: vi.fn() }))

import { initOpenFilesRefresh, reloadNonce, checkOpenFilesForExternalChanges } from './fileSync'
import * as ipc from '../lib/ipc'

const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  for (const k of Object.keys(tabs)) delete tabs[k]
  content.clear(); original.clear()
})

describe('open files follow edits made outside Verun', () => {
  test('a watcher event for a clean tab reloads it from disk while Verun stays focused', async () => {
    initOpenFilesRefresh()
    tabs.t1 = [{ relativePath: 'src/a.ts', name: 'a.ts', dirty: false }]
    content.set('t1:src/a.ts', 'old'); original.set('t1:src/a.ts', 'old')
    disk['/wt/src/a.ts'] = 'new from agent'
    const before = reloadNonce('t1', 'src/a.ts')
    handlers['file-tree-changed']({ payload: { taskId: 't1', path: 'src' } })
    for (let i = 0; i < 5; i++) await flush()
    expect(content.get('t1:src/a.ts')).toBe('new from agent')
    expect(reloadNonce('t1', 'src/a.ts')).toBe(before + 1)
  })

  test('events for other tasks or other folders do not read the file', async () => {
    initOpenFilesRefresh()
    tabs.t1 = [{ relativePath: 'src/a.ts', name: 'a.ts', dirty: false }]
    original.set('t1:src/a.ts', 'old')
    vi.mocked(ipc.readTextFile).mockClear()
    handlers['file-tree-changed']({ payload: { taskId: 't2', path: 'src' } })
    handlers['file-tree-changed']({ payload: { taskId: 't1', path: 'docs' } })
    for (let i = 0; i < 5; i++) await flush()
    expect(ipc.readTextFile).not.toHaveBeenCalled()
  })

  test('a change that lands during a check is not dropped', async () => {
    tabs.t1 = [{ relativePath: 'a.ts', name: 'a.ts', dirty: false }]
    original.set('t1:a.ts', 'v1'); content.set('t1:a.ts', 'v1')
    disk['/wt/a.ts'] = 'v2'
    let second: Promise<void> | undefined
    vi.mocked(ipc.readTextFile).mockImplementationOnce(async (p: string) => {
      const v = disk[p]
      // The agent writes again while the first check is reading.
      disk['/wt/a.ts'] = 'v3'
      second = checkOpenFilesForExternalChanges()
      return v
    })
    await checkOpenFilesForExternalChanges()
    await second
    for (let i = 0; i < 10; i++) await flush()
    expect(content.get('t1:a.ts')).toBe('v3')
  })
})
