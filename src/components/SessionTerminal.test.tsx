import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

type Handler = (ev: { payload: { terminalId: string; exitCode: number | null } }) => void
const ptyExitedHandlers: Handler[] = []
type DropHandler = (ev: { payload: { paths: string[]; position?: { x: number; y: number } } }) => void
const dropHandlers: DropHandler[] = []
const dropTargets = new Map<DropHandler, string | undefined>()
const webview = vi.hoisted(() => ({ label: 'main' }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ label: webview.label }) }))
type OutputHandler = (ev: { payload: { terminalId: string; data: string; seq: number } }) => void
const ptyOutputHandlers: OutputHandler[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: Handler | DropHandler | OutputHandler, options?: { target: { label: string } }) => {
    if (event === 'pty-exited') ptyExitedHandlers.push(handler as Handler)
    if (event === 'tauri://drag-drop') { dropHandlers.push(handler as DropHandler); dropTargets.set(handler as DropHandler, options?.target.label) }
    if (event === 'pty-output') ptyOutputHandlers.push(handler as OutputHandler)
    return Promise.resolve(() => {
      const a = ptyExitedHandlers.indexOf(handler as Handler)
      if (a !== -1) ptyExitedHandlers.splice(a, 1)
      const b = dropHandlers.indexOf(handler as DropHandler)
      if (b !== -1) dropHandlers.splice(b, 1)
      const c = ptyOutputHandlers.indexOf(handler as OutputHandler)
      if (c !== -1) ptyOutputHandlers.splice(c, 1)
    })
  }),
  emit: vi.fn(),
}))

const ipcMocks = vi.hoisted(() => ({
  claudeTerminalOpen: vi.fn(),
  claudeTerminalClose: vi.fn(() => Promise.resolve()),
  ptyWrite: vi.fn(() => Promise.resolve()),
}))
vi.mock('../lib/ipc', () => ipcMocks)

// xterm is inert in jsdom; replace ShellTerminal with a marker div so we can
// assert whether it rendered.
vi.mock('./ShellTerminal', () => ({
  ShellTerminal: (props: { terminalId: string; disableCmdVIntercept?: boolean }) => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'shell-terminal')
    el.setAttribute('data-terminal-id', props.terminalId)
    if (props.disableCmdVIntercept) el.setAttribute('data-disable-cmd-v', 'true')
    return el
  },
}))

import { SessionTerminal } from './SessionTerminal'
import { toasts, setToasts } from '../store/ui'

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
beforeEach(() => {
  webview.label = 'main'
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 } as DOMRect)
  ptyExitedHandlers.length = 0
  dropHandlers.length = 0
  ptyOutputHandlers.length = 0
  setToasts([])
  ipcMocks.claudeTerminalOpen.mockReset()
  ipcMocks.claudeTerminalClose.mockReset()
  ipcMocks.ptyWrite.mockReset()
  ipcMocks.claudeTerminalClose.mockResolvedValue(undefined)
  ipcMocks.ptyWrite.mockResolvedValue(undefined as unknown as void)
  cleanup()
})

describe('SessionTerminal', () => {
  test('opens the claude terminal on mount and renders ShellTerminal', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { getByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    expect(ipcMocks.claudeTerminalOpen).toHaveBeenCalledWith('s-1', 24, 80)
    const shell = getByTestId('shell-terminal')
    expect(shell.getAttribute('data-terminal-id')).toBe('term-1')
  })

  // Claude terminal mode uses the same Cmd+V path as other terminals: images
  // and Finder files are pasted as paths, which Claude attaches reliably.
  // Relying on Claude polling NSPasteboard after an empty paste was flaky.
  test('does not disable the Cmd+V intercept', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { getByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    const shell = getByTestId('shell-terminal')
    expect(shell.getAttribute('data-disable-cmd-v')).toBeNull()
  })

  test('shows a reconnect button when the matching pty-exited event fires', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { findByText, queryByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    // Simulate Claude exiting (Ctrl+D / /exit / crash)
    for (const h of ptyExitedHandlers) h({ payload: { terminalId: 'term-1', exitCode: 0 } })
    await flush()

    expect(queryByTestId('shell-terminal')).toBeNull()
    await findByText(/claude.*exited/i)
    await findByText(/reconnect/i)
  })

  test('ignores pty-exited events for unrelated terminals', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { getByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    for (const h of ptyExitedHandlers) h({ payload: { terminalId: 'other-term', exitCode: 0 } })
    await flush()

    expect(getByTestId('shell-terminal')).toBeTruthy()
  })

  test('renders the backend error when claudeTerminalOpen rejects', async () => {
    ipcMocks.claudeTerminalOpen.mockRejectedValue(new Error('Session has no resumable id yet - send a message first'))
    const { findByText, queryByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    expect(queryByTestId('shell-terminal')).toBeNull()
    await findByText(/no resumable id/i)
  })

  test('renders a string error when ipc rejects with a non-Error value', async () => {
    ipcMocks.claudeTerminalOpen.mockRejectedValue('boom')
    const { findByText } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    await findByText(/boom/)
  })

  // A signed-out or removed account is not a terminal fault: the user gets the
  // account toast with a way to fix it, and Reconnect to try again afterwards.
  describe('when the session\'s account cannot be used', () => {
    const signedOut = 'ACCOUNT_ERROR:{"kind":"signedOut","accountId":"a1","label":"Acme","projects":[],"message":null}'

    test('shows the account toast instead of the raw error, and offers Reconnect', async () => {
      ipcMocks.claudeTerminalOpen.mockRejectedValue(signedOut)
      const { findByText, queryByText, queryByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
      await flush()

      expect(toasts().map(t => ({ title: t.title, message: t.message, actions: t.actions?.map(a => a.label) }))).toEqual([
        { title: 'Account signed out', message: 'Acme is signed out.', actions: ['Log in'] },
      ])
      expect(queryByText(/ACCOUNT_ERROR/)).toBeNull()
      expect(queryByTestId('shell-terminal')).toBeNull()
      // Not left on "Starting Claude Code..." with nothing that can end it.
      expect(queryByText(/starting claude code/i)).toBeNull()
      await findByText(/reconnect/i)
    })

    test('Reconnect opens the terminal once the account works', async () => {
      ipcMocks.claudeTerminalOpen
        .mockRejectedValueOnce(signedOut)
        .mockResolvedValueOnce({ terminalId: 'term-1', sessionId: 's-1' })
      const { findByText, findByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
      await flush()

      fireEvent.click(await findByText(/reconnect/i))
      await flush()

      expect(ipcMocks.claudeTerminalOpen).toHaveBeenCalledTimes(2)
      expect((await findByTestId('shell-terminal')).getAttribute('data-terminal-id')).toBe('term-1')
    })

    test('other errors still show their text and no toast', async () => {
      ipcMocks.claudeTerminalOpen.mockRejectedValue('Session has no resumable id yet')
      const { findByText } = render(() => <SessionTerminal sessionId="s-1" />)
      await flush()

      await findByText(/no resumable id/i)
      expect(toasts()).toEqual([])
    })
  })

  test('reconnecting after an exit clears the previous error state', async () => {
    ipcMocks.claudeTerminalOpen
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockResolvedValueOnce({ terminalId: 'term-1', sessionId: 's-1' })
    const { findByText, findByTestId, queryByText } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    await findByText(/initial failure/)
    // Error path doesn't show reconnect — that's the exited path. Verify the
    // error stays put until the user takes a different action.
    expect(queryByText(/reconnect/i)).toBeNull()
    // (No assertion on a non-existent reconnect here; this test asserts the
    // error text persists rather than being silently swapped.)
    expect(await findByText(/initial failure/)).toBeTruthy()
    // The shell terminal must not have rendered.
    expect(() => findByTestId('shell-terminal')).rejects
  })

  // Regression: SessionTerminal used to close the Claude PTY on unmount,
  // which made every session-tab switch respawn `claude --resume` and lose
  // the running TUI's scrollback. Now we leave the PTY alive — backend
  // `claude_terminal_open` is idempotent so the next mount rejoins it,
  // and real cleanup happens at session-close (`close_all_for_task`).
  test('does NOT close the Claude PTY on unmount (preserves running TUI across remounts)', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { unmount } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    unmount()
    expect(ipcMocks.claudeTerminalClose).not.toHaveBeenCalled()
  })

  test('shows the booting-claude overlay until the first pty-output arrives', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { queryByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    // ShellTerminal mounts; the overlay sits on top until claude prints.
    expect(queryByTestId('shell-terminal')).toBeTruthy()
    expect(queryByTestId('claude-terminal-loading')).toBeTruthy()

    // First byte from claude.
    for (const h of ptyOutputHandlers) {
      h({ payload: { terminalId: 'term-1', data: 'Welcome to Claude Code\n', seq: 22 } })
    }
    await flush()

    expect(queryByTestId('claude-terminal-loading')).toBeNull()
  })

  test('overlay ignores pty-output for unrelated terminals', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { queryByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    expect(queryByTestId('claude-terminal-loading')).toBeTruthy()

    for (const h of ptyOutputHandlers) {
      h({ payload: { terminalId: 'other-term', data: 'noise', seq: 5 } })
    }
    await flush()

    // Still loading - the byte was for a different PTY.
    expect(queryByTestId('claude-terminal-loading')).toBeTruthy()
  })

  test('overlay treats empty-data events as not-yet-arrived', async () => {
    // Some keepalive / no-op pty-output payloads carry an empty data string.
    // Don't false-trigger the "ready" state on those.
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { queryByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    for (const h of ptyOutputHandlers) {
      h({ payload: { terminalId: 'term-1', data: '', seq: 0 } })
    }
    await flush()

    expect(queryByTestId('claude-terminal-loading')).toBeTruthy()
  })

  test('drag-drop forwards quoted paths to the PTY', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    for (const h of dropHandlers) {
      h({ payload: { paths: ['/tmp/a.png', '/tmp/My Pictures/b.png'] } })
    }
    await flush()

    expect(ipcMocks.ptyWrite).toHaveBeenCalledTimes(1)
    expect(ipcMocks.ptyWrite).toHaveBeenCalledWith('term-1', "'/tmp/a.png' '/tmp/My Pictures/b.png' ")
  })

  // Repeated drops continue working without remounting the terminal.
  test('drag-drop fires repeatedly in the visible terminal', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    for (const h of dropHandlers) {
      h({ payload: { paths: ['/tmp/first.png'] } })
      h({ payload: { paths: ['/tmp/second.png'] } })
      h({ payload: { paths: ['/tmp/third.png'] } })
    }
    await flush()

    expect(ipcMocks.ptyWrite).toHaveBeenCalledTimes(3)
    expect(ipcMocks.ptyWrite).toHaveBeenNthCalledWith(1, 'term-1', "'/tmp/first.png' ")
    expect(ipcMocks.ptyWrite).toHaveBeenNthCalledWith(2, 'term-1', "'/tmp/second.png' ")
    expect(ipcMocks.ptyWrite).toHaveBeenNthCalledWith(3, 'term-1', "'/tmp/third.png' ")
  })

  test('empty paths list does not write to the PTY', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    for (const h of dropHandlers) {
      h({ payload: { paths: [] } })
    }
    await flush()

    expect(ipcMocks.ptyWrite).not.toHaveBeenCalled()
  })

  test('clicking reconnect re-invokes claudeTerminalOpen and mounts a fresh ShellTerminal', async () => {
    ipcMocks.claudeTerminalOpen
      .mockResolvedValueOnce({ terminalId: 'term-1', sessionId: 's-1' })
      .mockResolvedValueOnce({ terminalId: 'term-2', sessionId: 's-1' })

    const { findByText, findByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()

    for (const h of ptyExitedHandlers) h({ payload: { terminalId: 'term-1', exitCode: 0 } })
    await flush()

    const reconnect = await findByText(/reconnect/i)
    fireEvent.click(reconnect)
    await flush()

    expect(ipcMocks.claudeTerminalOpen).toHaveBeenCalledTimes(2)
    const shell = await findByTestId('shell-terminal')
    expect(shell.getAttribute('data-terminal-id')).toBe('term-2')
  })
})

test('a native drop targets only its own window, not another mounted session', async () => {
  ipcMocks.claudeTerminalOpen.mockImplementation((id: string) => Promise.resolve({ terminalId: `term-${id}` }))
  render(() => <SessionTerminal sessionId="one" />)
  webview.label = 'detached'
  render(() => <SessionTerminal sessionId="two" />)
  await flush()
  for (const handler of dropHandlers) {
    if (!dropTargets.get(handler) || dropTargets.get(handler) === 'detached') handler({ payload: { paths: ['/tmp/image.png'] } })
  }
  expect(ipcMocks.ptyWrite.mock.calls).toEqual([['term-two', "'/tmp/image.png' "]])
})
test('hidden sessions and drops outside the terminal ignore attachments; physical coordinates respect display scale', async () => {
  ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1' })
  const view = render(() => <SessionTerminal sessionId="one" />)
  await flush()
  const root = view.container.firstElementChild as HTMLElement
  const rects = vi.spyOn(root, 'getClientRects').mockReturnValue([] as unknown as DOMRectList)
  dropHandlers[0]({ payload: { paths: ['/tmp/hidden.png'] } })
  expect(ipcMocks.ptyWrite).not.toHaveBeenCalled()
  rects.mockReturnValue([root.getBoundingClientRect()] as unknown as DOMRectList)
  vi.stubGlobal('devicePixelRatio', 2)
  dropHandlers[0]({ payload: { paths: ['/tmp/outside.png'], position: { x: 1200, y: 100 } } })
  expect(ipcMocks.ptyWrite).not.toHaveBeenCalled()
  dropHandlers[0]({ payload: { paths: ['/tmp/inside.png'], position: { x: 800, y: 600 } } })
  expect(ipcMocks.ptyWrite).toHaveBeenCalledWith('term-1', "'/tmp/inside.png' ")
})

test('closing before async listener registration completes removes every listener', async () => {
  ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1' })
  const view = render(() => <SessionTerminal sessionId="one" />)
  view.unmount()
  await flush()
  expect(dropHandlers).toHaveLength(0)
  expect(ptyOutputHandlers).toHaveLength(0)
  expect(ptyExitedHandlers).toHaveLength(0)
})
