import { test, expect, vi } from 'vitest'
import { createRoot, createSignal } from 'solid-js'

const [nonce, setNonce] = createSignal(0)
vi.mock('../store/fileSync', () => ({ reloadNonce: () => nonce() }))
const cache = new Map<string, string>()
vi.mock('../store/files', () => ({
  getCachedContent: (t: string, p: string) => cache.get(`${t}:${p}`),
  setCachedContent: (t: string, p: string, v: string) => cache.set(`${t}:${p}`, v),
  setCachedOriginal: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ readWorktreeFile: vi.fn(async () => 'from disk') }))
import { createPreviewContent } from './previewContent'

const flush = () => new Promise(r => setTimeout(r, 0))

test('a preview loads its file and follows reloads after an outside edit', async () => {
  await createRoot(async dispose => {
    const c = createPreviewContent(() => 't1', () => 'README.md')
    await flush()
    expect(c.content()).toBe('from disk')
    expect(c.loading()).toBe(false)
    cache.set('t1:README.md', 'edited by an agent')
    setNonce(1)
    await flush()
    expect(c.content()).toBe('edited by an agent')
    dispose()
  })
})
