import { describe, test, expect, vi, beforeEach } from 'vitest'

const ipcMocks = vi.hoisted(() => ({
  ptyWrite: vi.fn(() => Promise.resolve()),
  readClipboard: vi.fn(() => Promise.resolve('')),
  readClipboardPaste: vi.fn(() => Promise.resolve({ kind: 'text', text: '' } as unknown)),
}))
vi.mock('../lib/platform', () => ({ isMac: true, modPressed: (e: KeyboardEvent) => e.metaKey }))
vi.mock('../lib/ipc', () => ipcMocks)
// xterm.css import inside ShellTerminal.tsx has no meaning in jsdom.
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import { setupCaptureKeyHandler, setupXtermPassthrough } from './ShellTerminal'
import type { Terminal as XTerm } from '@xterm/xterm'

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
}

beforeEach(() => {
  ipcMocks.ptyWrite.mockReset()
  ipcMocks.ptyWrite.mockResolvedValue(undefined as unknown as void)
})

describe('Shift+Enter in terminals', () => {
  test('capture handler writes ESC+CR to the pty so TUIs insert a newline instead of submitting', () => {
    const container = document.createElement('div')
    const term = { getSelection: () => '' } as unknown as XTerm
    setupCaptureKeyHandler(container, term, 'term-1')

    const e = keydown({ key: 'Enter', shiftKey: true })
    container.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(true)
    expect(ipcMocks.ptyWrite).toHaveBeenCalledTimes(1)
    expect(ipcMocks.ptyWrite).toHaveBeenCalledWith('term-1', '\x1b\r')
  })

  test('plain Enter is left alone by the capture handler (xterm sends its normal CR)', () => {
    const container = document.createElement('div')
    const term = { getSelection: () => '' } as unknown as XTerm
    setupCaptureKeyHandler(container, term, 'term-1')

    const e = keydown({ key: 'Enter' })
    container.dispatchEvent(e)

    expect(e.defaultPrevented).toBe(false)
    expect(ipcMocks.ptyWrite).not.toHaveBeenCalled()
  })

  test('passthrough tells xterm to stand down on Shift+Enter so it does not also emit CR', () => {
    let handler: ((e: KeyboardEvent) => boolean) | undefined
    const term = {
      attachCustomKeyEventHandler: (fn: (e: KeyboardEvent) => boolean) => { handler = fn },
    } as unknown as XTerm
    setupXtermPassthrough(term)

    expect(handler).toBeDefined()
    expect(handler!(keydown({ key: 'Enter', shiftKey: true }))).toBe(false)
    expect(handler!(keydown({ key: 'Enter' }))).toBe(true)
  })
})

describe('Cmd+V in terminals', () => {
  const flush = () => new Promise(r => setTimeout(r, 0))

  test.each([
    [{ kind: 'image', path: '/tmp/verun-paste/a.png' }, "'/tmp/verun-paste/a.png' "],
    [{ kind: 'files', paths: ['/Users/me/My Doc.pdf'] }, "'/Users/me/My Doc.pdf' "],
    [{ kind: 'text', text: 'echo hi' }, 'echo hi'],
    // Empty paste still goes through so TUIs can run their own clipboard fallback
    [{ kind: 'text', text: '' }, ''],
  ])('pastes %o as %j', async (clip, expected) => {
    ipcMocks.readClipboardPaste.mockResolvedValueOnce(clip)
    const container = document.createElement('div')
    const paste = vi.fn()
    const term = { getSelection: () => '', paste } as unknown as XTerm
    setupCaptureKeyHandler(container, term, 'term-1')

    const e = keydown({ key: 'v', metaKey: true })
    container.dispatchEvent(e)
    await flush()

    expect(e.defaultPrevented).toBe(true)
    expect(paste).toHaveBeenCalledWith(expected)
  })
})
