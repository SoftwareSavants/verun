import { beforeEach, describe, expect, test, vi } from 'vitest'

const checkGitignoredMock = vi.fn<(taskId: string, paths: string[]) => Promise<string[]>>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({
  checkGitignored: (taskId: string, paths: string[]) => checkGitignoredMock(taskId, paths),
}))
vi.mock('./files', () => ({
  isDiffKey: (_p: string) => false,
  diffTabKey: (taskId: string, p: string) => `diff:${taskId}:${p}`,
  getDirContents: () => [],
  loadDirectory: vi.fn(() => Promise.resolve()),
  clearCachedContent: vi.fn(),
}))
vi.mock('./ui', () => ({ setRightPanelTab: vi.fn() }))

const { revealFileInTree, revealRequest, expandDir, _clearIgnoreCacheForTests } = await import('./editorView')

beforeEach(() => {
  checkGitignoredMock.mockReset()
  _clearIgnoreCacheForTests()
})

describe('revealFileInTree gitignore gating', () => {
  test('does not emit a reveal request when the path is gitignored', async () => {
    checkGitignoredMock.mockResolvedValue(['node_modules'])
    await revealFileInTree('t1', 'node_modules/foo/bar.ts')
    expect(revealRequest()).toBeNull()
  })

  test('still reveals regular files', async () => {
    checkGitignoredMock.mockResolvedValue([])
    await revealFileInTree('t1', 'src/foo.ts')
    const req = revealRequest()
    expect(req?.relativePath).toBe('src/foo.ts')
  })

  test('caches the gitignore answer per task (no duplicate IPC)', async () => {
    checkGitignoredMock.mockResolvedValue(['dist'])
    await revealFileInTree('t1', 'dist/one.js')
    await revealFileInTree('t1', 'dist/two.js')
    // first call checks ['dist', 'dist/one.js']; second hits the ancestor
    // cache and doesn't call IPC again.
    expect(checkGitignoredMock).toHaveBeenCalledTimes(1)
  })
})

// Silence the unused-import warning for expandDir — imported only to ensure
// the module initializes cleanly in the test harness.
void expandDir
