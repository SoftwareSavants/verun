import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest'
import { render } from '@solidjs/testing-library'

// A hidden terminal view must stop parsing output: unmounting detaches the
// Rust-side subscription, and mounting again resumes from the checkpoint.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
})
const ipcMocks = vi.hoisted(() => ({
  ptyWrite: vi.fn(() => Promise.resolve()),
  ptyResize: vi.fn(() => Promise.resolve()),
  ptyListen: vi.fn(() => Promise.resolve()),
  ptyUnlisten: vi.fn(() => Promise.resolve()),
  readClipboard: vi.fn(() => Promise.resolve('')),
  resolveTerminalFile: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../lib/ipc', () => ipcMocks)
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
const webgl = vi.hoisted(() => ({ disposed: new Set<object>() }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    activate() {}
    dispose() { webgl.disposed.add(this) }
  },
}))

import { ShellTerminal } from './ShellTerminal'
import { getXtermEntry } from '../store/terminals'

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {},
    }),
  })
  class Observer { observe() {} unobserve() {} disconnect() {} }
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    Object.defineProperty(window, name, { configurable: true, value: Observer })
  }
})
afterAll(() => vi.unstubAllGlobals())

describe('<ShellTerminal /> output subscription', () => {
  test('detaches on unmount and resumes on remount', () => {
    const first = render(() => <ShellTerminal terminalId="lifecycle-1" />)
    expect(ipcMocks.ptyListen).toHaveBeenCalledWith('lifecycle-1', 0)
    expect(ipcMocks.ptyUnlisten).not.toHaveBeenCalled()

    first.unmount()
    expect(ipcMocks.ptyUnlisten).toHaveBeenCalledWith('lifecycle-1')

    ipcMocks.ptyListen.mockClear()
    const second = render(() => <ShellTerminal terminalId="lifecycle-1" />)
    expect(ipcMocks.ptyListen).toHaveBeenCalledWith('lifecycle-1', 0)
    second.unmount()
    getXtermEntry('lifecycle-1')?.term.dispose()
  })
})

// xterm's WebGL renderers share one glyph atlas. Clearing it from one terminal
// leaves every other renderer drawing cells from glyphs that are gone (blank or
// garbled text, backgrounds intact), and a refresh keeps those cells. Only a
// fresh renderer redraws them.
describe('<ShellTerminal /> WebGL renderer', () => {
  test('a terminal shown again gets a fresh renderer', () => {
    const first = render(() => <ShellTerminal terminalId="renderer-1" />)
    const before = getXtermEntry('renderer-1')!.webglAddon!
    first.unmount()
    const second = render(() => <ShellTerminal terminalId="renderer-1" />)
    const after = getXtermEntry('renderer-1')!.webglAddon
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
    expect(webgl.disposed.has(before)).toBe(true)
    second.unmount()
    getXtermEntry('renderer-1')?.term.dispose()
  })

  test('coming back to the window renews the renderer and never clears the shared atlas', () => {
    const view = render(() => <ShellTerminal terminalId="renderer-2" />)
    const entry = getXtermEntry('renderer-2')!
    const before = entry.webglAddon
    const clear = vi.spyOn(entry.term, 'clearTextureAtlas')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(clear).not.toHaveBeenCalled()
    expect(entry.webglAddon).not.toBe(before)
    view.unmount()
    entry.term.dispose()
  })
})
