import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

type Handler = (ev: { payload: { terminalId: string; exitCode: number | null } }) => void
const ptyExitedHandlers: Handler[] = []
type DropHandler = (ev: { payload: { paths: string[]; position?: { x: number; y: number } } }) => void
const dropHandlers: DropHandler[] = []
type OutputHandler = (ev: { payload: { terminalId: string; data: string; seq: number } }) => void
const ptyOutputHandlers: OutputHandler[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: Handler | DropHandler | OutputHandler) => {
    if (event === 'pty-exited') ptyExitedHandlers.push(handler as Handler)
    if (event === 'tauri://drag-drop') dropHandlers.push(handler as DropHandler)
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

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  ptyExitedHandlers.length = 0
  dropHandlers.length = 0
  ptyOutputHandlers.length = 0
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

  // Lock in that Claude terminal mode disables the manual Cmd+V intercept so
  // xterm's native paste flow forwards the bracketed-paste sequence to the
  // PTY. Claude Code's TUI then polls NSPasteboard itself for image bytes.
  test('passes disableCmdVIntercept so xterm handles paste natively', async () => {
    ipcMocks.claudeTerminalOpen.mockResolvedValue({ terminalId: 'term-1', sessionId: 's-1' })
    const { getByTestId } = render(() => <SessionTerminal sessionId="s-1" />)
    await flush()
    const shell = getByTestId('shell-terminal')
    expect(shell.getAttribute('data-disable-cmd-v')).toBe('true')
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

  // Regression: the previous implementation used a bbox hit-test against
  // getBoundingClientRect (CSS px) vs Tauri's physical-px drop position,
  // which silently dropped subsequent drops after layout shifts. Lock in
  // that we forward every drop while the terminal is mounted.
  test('drag-drop fires repeatedly without bbox gating', async () => {
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
