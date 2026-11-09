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
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    activate() {}
    dispose() {}
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
