import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import type { Account } from '../types'

// The dialog runs the harness's login or logout command in a PTY, shows it in a
// terminal, and offers Done once the command has ended. Whatever happens, the PTY
// is closed with the dialog: an ended PTY stays in the backend until it is closed.
type ExitedEvent = { payload: { terminalId: string; exitCode?: number | null } }
const mocks = vi.hoisted(() => ({
  exitedHandlers: [] as Array<(event: ExitedEvent) => void>,
  order: [] as string[],
  // What `listen` resolves after. A test swaps it to hold the registration back.
  listenReady: { promise: Promise.resolve() },
  startAccountTerminal: vi.fn(),
  ptyClose: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (event: ExitedEvent) => void) => {
    mocks.order.push(`listen ${event}`)
    mocks.exitedHandlers.push(handler)
    return mocks.listenReady.promise.then(() => () => {
      const i = mocks.exitedHandlers.indexOf(handler)
      if (i !== -1) mocks.exitedHandlers.splice(i, 1)
    })
  }),
  emit: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({
  startAccountTerminal: mocks.startAccountTerminal,
  ptyClose: mocks.ptyClose,
}))
// xterm is inert in jsdom: a marker div stands in for the terminal.
vi.mock('./ShellTerminal', () => ({
  ShellTerminal: (props: { terminalId: string }) => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'shell-terminal')
    el.setAttribute('data-terminal-id', props.terminalId)
    return el
  },
}))

import { AccountTerminalDialog } from './AccountTerminalDialog'
import { toasts, setToasts } from '../store/ui'

const account: Account = {
  id: 'a1',
  agentType: 'claude',
  label: 'Acme',
  color: '#7c3aed',
  configDir: '/acc/a1',
  managedDir: true,
  env: [],
  removedAt: null,
  createdAt: 1000,
  identity: { status: 'signedOut', email: null, orgName: null, plan: null, providers: [] },
}

const BROWSER_NOTE = 'Your browser signs in with whichever account it is already using. If that is the wrong one, copy the link from the terminal into the right browser profile.'
const busy = 'ACCOUNT_ERROR:{"kind":"busy","accountId":null,"label":null,"projects":[],"message":null}'

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/** The `pty-exited` event the backend sends when a terminal's process has ended. */
function exit(terminalId: string, exitCode: number | null = 0) {
  for (const handler of [...mocks.exitedHandlers]) handler({ payload: { terminalId, exitCode } })
}

function open(action: 'login' | 'logout' = 'login', onClose: () => void = () => {}) {
  return render(() => <AccountTerminalDialog account={account} action={action} onClose={onClose} />)
}

beforeEach(() => {
  mocks.exitedHandlers.length = 0
  mocks.order.length = 0
  mocks.listenReady.promise = Promise.resolve()
  mocks.startAccountTerminal.mockReset()
  mocks.startAccountTerminal.mockImplementation(async () => {
    mocks.order.push('start')
    return { terminalId: 't1', hint: null }
  })
  mocks.ptyClose.mockReset()
  mocks.ptyClose.mockResolvedValue(undefined)
  setToasts([])
})

afterEach(() => cleanup())

describe('AccountTerminalDialog', () => {
  test('Log in starts a login terminal and shows it', async () => {
    open('login')
    await flush()

    expect(mocks.startAccountTerminal).toHaveBeenCalledWith('a1', 'login', 24, 80)
    expect(screen.getByTestId('shell-terminal').getAttribute('data-terminal-id')).toBe('t1')
  })

  test('Log out starts a logout terminal', async () => {
    open('logout')
    await flush()

    expect(mocks.startAccountTerminal).toHaveBeenCalledWith('a1', 'logout', 24, 80)
    expect(screen.getByTestId('shell-terminal').getAttribute('data-terminal-id')).toBe('t1')
  })

  test('the title names the action and the account', async () => {
    open('login')
    expect(screen.getByRole('heading').textContent).toBe('Log in to Acme')
    cleanup()

    open('logout')
    expect(screen.getByRole('heading').textContent).toBe('Log out of Acme')
  })

  test('a login says which account the browser uses, then the backend hint, then the terminal', async () => {
    mocks.startAccountTerminal.mockResolvedValue({ terminalId: 't1', hint: 'Pick a provider, then press Enter.' })
    open('login')
    await flush()

    const note = screen.getByText(BROWSER_NOTE)
    const hint = screen.getByText('Pick a provider, then press Enter.')
    const terminal = screen.getByTestId('shell-terminal')
    expect(note.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hint.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('a logout has no browser note, only the hint', async () => {
    mocks.startAccountTerminal.mockResolvedValue({ terminalId: 't1', hint: 'Type /auth signout.' })
    open('logout')
    await flush()

    expect(screen.queryByText(BROWSER_NOTE)).toBeNull()
    expect(screen.getByText('Type /auth signout.')).toBeTruthy()
  })

  test('there is no hint line when the backend sends none', async () => {
    open('login')
    await flush()

    expect(screen.getAllByText(/./, { selector: 'p' }).map((p) => p.textContent)).toEqual([BROWSER_NOTE])
  })

  test('shows Done after the login terminal exits', async () => {
    open('login')
    await flush()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    exit('t1')
    await flush()

    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    // The terminal's window is gone by then (the store disposes an ended terminal's xterm).
    expect(screen.queryByTestId('shell-terminal')).toBeNull()
    expect(screen.getByText('The command has ended.')).toBeTruthy()
  })

  test('a command that failed says with which exit code', async () => {
    open('login')
    await flush()

    exit('t1', 127)
    await flush()

    expect(screen.getByText('The command ended with exit code 127.')).toBeTruthy()
  })

  test('ignores pty-exited events of other terminals', async () => {
    open('login')
    await flush()

    exit('some-shell')
    await flush()

    expect(screen.getByTestId('shell-terminal')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  test('an exit that arrives before the start call returns is not lost', async () => {
    let started!: (terminal: { terminalId: string; hint: string | null }) => void
    mocks.startAccountTerminal.mockReturnValue(new Promise((resolve) => { started = resolve }))
    open('login')
    await flush()
    expect(mocks.startAccountTerminal).toHaveBeenCalledOnce()

    // A command that fails at once ends before the invoke resolves.
    exit('t1', 127)
    started({ terminalId: 't1', hint: null })
    await flush()

    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })

  test('listens for the exit before it starts the terminal', async () => {
    let registered!: () => void
    mocks.listenReady.promise = new Promise<void>((resolve) => { registered = resolve })
    open('login')
    await flush()

    // The registration has not completed, so nothing may be started yet.
    expect(mocks.order).toEqual(['listen pty-exited'])
    expect(mocks.startAccountTerminal).not.toHaveBeenCalled()

    registered()
    await flush()

    expect(mocks.order).toEqual(['listen pty-exited', 'start'])
  })

  test('Cancel closes the running terminal and the dialog', async () => {
    const onClose = vi.fn()
    open('login', onClose)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mocks.ptyClose).toHaveBeenCalledOnce()
    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('Done still closes the PTY of the ended terminal', async () => {
    const onClose = vi.fn()
    open('login', onClose)
    await flush()
    exit('t1')
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    // An ended PTY stays in the backend's map until somebody closes it.
    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('closes the PTY once, whether the dialog is dismissed or removed afterwards', async () => {
    const onClose = vi.fn()
    const view = open('login', onClose)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    view.unmount()

    expect(mocks.ptyClose).toHaveBeenCalledOnce()
  })

  test('a dialog taken away without being dismissed closes the PTY and stops listening', async () => {
    const view = open('login')
    await flush()
    expect(mocks.exitedHandlers).toHaveLength(1)

    view.unmount()
    await flush()

    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    expect(mocks.exitedHandlers).toHaveLength(0)
  })

  test('Escape closes the dialog, not the Settings page behind it', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    const onClose = vi.fn()
    open('login', onClose)
    await flush()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', behind)

    expect(onClose).toHaveBeenCalledOnce()
    expect(behind).not.toHaveBeenCalled()
    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
  })

  test('closing before the listener is registered starts nothing and leaves no listener', async () => {
    let registered!: () => void
    mocks.listenReady.promise = new Promise<void>((resolve) => { registered = resolve })
    const view = open('login')
    view.unmount()

    registered()
    await flush()

    expect(mocks.startAccountTerminal).not.toHaveBeenCalled()
    expect(mocks.exitedHandlers).toHaveLength(0)
  })

  test('closing while the terminal is starting closes it as soon as it exists', async () => {
    let started!: (terminal: { terminalId: string; hint: string | null }) => void
    mocks.startAccountTerminal.mockReturnValue(new Promise((resolve) => { started = resolve }))
    const onClose = vi.fn()
    open('login', onClose)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.ptyClose).not.toHaveBeenCalled()

    started({ terminalId: 't1', hint: null })
    await flush()

    expect(mocks.ptyClose).toHaveBeenCalledOnce()
    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    expect(screen.queryByTestId('shell-terminal')).toBeNull()
  })

  describe('when the terminal cannot be started', () => {
    test('another login being open shows the account toast and its sentence, with nothing to close', async () => {
      mocks.startAccountTerminal.mockRejectedValue(busy)
      const onClose = vi.fn()
      open('login', onClose)
      await flush()

      expect(toasts().map((t) => ({ title: t.title, message: t.message }))).toEqual([
        { title: 'Login already open', message: 'Finish or close the other login first.' },
      ])
      // The dialog keeps the sentence on screen after the toast is gone, instead of the raw error.
      expect(screen.getByText('Finish or close the other login first.')).toBeTruthy()
      expect(screen.queryByText(/ACCOUNT_ERROR/)).toBeNull()
      expect(screen.queryByTestId('shell-terminal')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(onClose).toHaveBeenCalledOnce()
      expect(mocks.ptyClose).not.toHaveBeenCalled()
    })

    test('any other error is shown as it is, without a toast', async () => {
      mocks.startAccountTerminal.mockRejectedValue('Failed to open PTY: no ptys left')
      open('login')
      await flush()

      expect(screen.getByText('Failed to open PTY: no ptys left')).toBeTruthy()
      expect(toasts()).toEqual([])
    })
  })
})
