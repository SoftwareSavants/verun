import { describe, test, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'

// The find box of a terminal closes on Escape and that is all Escape does there.
// A dialog that holds the terminal (the login dialog) and the Settings page
// behind it both close on Escape too, and neither is what the key was for.
// xterm asks a canvas for a context while it loads, and jsdom answers null with a
// notice per ask. Answering null quietly, before xterm is imported, is the same.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
})
const ipcMocks = vi.hoisted(() => ({
  ptyWrite: vi.fn(() => Promise.resolve()),
  ptyResize: vi.fn(() => Promise.resolve()),
  ptyListen: vi.fn(() => Promise.resolve()),
  readClipboard: vi.fn(() => Promise.resolve('')),
  resolveTerminalFile: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../lib/ipc', () => ipcMocks)
// xterm.css has no meaning in jsdom, and neither has WebGL: the terminal falls back to its DOM renderer.
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

// xterm reaches for these while it opens; jsdom ships none of them. It also fits
// and scrolls the terminal on the next frame, which needs a layout jsdom has not
// got, so no frame is run.
beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    Object.defineProperty(window, name, { configurable: true, value: Observer })
  }
})

afterAll(() => vi.unstubAllGlobals())

// The terminal store keeps an xterm for every id it has seen, so each test gets an id of its own.
let terminalCount = 0
const mounted: string[] = []

afterEach(() => {
  cleanup()
  for (const id of mounted.splice(0)) getXtermEntry(id)?.term.dispose()
})

const FIND = 'Find in terminal...'

/** Shows a terminal and opens its find box with the shortcut (Cmd+F, which jsdom reads as Ctrl+F). */
function openFindBox(): HTMLInputElement {
  const terminalId = `search-test-${terminalCount++}`
  mounted.push(terminalId)
  // A terminal that is new to the store, not one that is joined again.
  expect(getXtermEntry(terminalId)).toBeUndefined()
  const view = render(() => <ShellTerminal terminalId={terminalId} />)
  fireEvent.keyDown(view.container.firstElementChild as HTMLElement, { key: 'f', ctrlKey: true, metaKey: true })
  return screen.getByPlaceholderText(FIND) as HTMLInputElement
}

describe('Escape in the find box', () => {
  test('closes the find box', () => {
    const input = openFindBox()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByPlaceholderText(FIND)).toBeNull()
  })

  test('goes no further, so the dialog and the page behind keep their place', () => {
    const input = openFindBox()
    // What closes on Escape behind the terminal: a dialog, and Settings, listen on the window.
    const behind = vi.fn()
    window.addEventListener('keydown', behind)

    fireEvent.keyDown(input, { key: 'Escape' })
    window.removeEventListener('keydown', behind)

    expect(behind).not.toHaveBeenCalled()
  })

  test('other keys typed in the find box still reach the window', () => {
    const input = openFindBox()
    const behind = vi.fn()
    window.addEventListener('keydown', behind)

    fireEvent.keyDown(input, { key: 'a' })
    window.removeEventListener('keydown', behind)

    expect(behind).toHaveBeenCalledOnce()
    expect(screen.queryByPlaceholderText(FIND)).not.toBeNull()
  })
})
