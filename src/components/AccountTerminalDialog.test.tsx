import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import type { Account } from '../types'

// The dialog runs the harness's login or logout command in a PTY, shows it in a
// terminal, and offers Done once the command has ended. The terminal stays after
// the command has ended, so what it printed can be read, and goes with the
// dialog. Whatever happens, the PTY is closed with the dialog: an ended PTY
// stays in the backend until it is closed.
type Handler = (event: { payload: unknown }) => void
const mocks = vi.hoisted(() => ({
  // The handlers `listen` was given, by event: the dialog's, and the terminal
  // store's own in the tests that start it.
  handlers: {} as Record<string, Array<(event: { payload: unknown }) => void>>,
  order: [] as string[],
  // What `listen` resolves after. A test swaps it to hold the registration back.
  listenReady: { promise: Promise.resolve() },
  startAccountTerminal: vi.fn(),
  ptyClose: vi.fn(),
  ptyListen: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: Handler) => {
    mocks.order.push(`listen ${event}`)
    ;(mocks.handlers[event] ??= []).push(handler)
    return mocks.listenReady.promise.then(() => () => {
      const handlers = mocks.handlers[event] ?? []
      const i = handlers.indexOf(handler)
      if (i !== -1) handlers.splice(i, 1)
    })
  }),
  emit: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({
  startAccountTerminal: mocks.startAccountTerminal,
  ptyClose: mocks.ptyClose,
  ptyListen: mocks.ptyListen,
}))
// xterm is inert in jsdom: a marker div stands in for the terminal.
vi.mock('./ShellTerminal', async () => {
  const { createEffect } = await import('solid-js')
  return {
    ShellTerminal: (props: { terminalId: string; isStopped?: () => boolean }) => {
      const el = document.createElement('div')
      el.setAttribute('data-testid', 'shell-terminal')
      el.setAttribute('data-terminal-id', props.terminalId)
      // What the real terminal does with it: nothing typed reaches an ended command.
      createEffect(() => el.setAttribute('data-stopped', String(props.isStopped?.() ?? false)))
      // xterm handles the keys typed into it and does not let them bubble.
      el.addEventListener('keydown', (e) => e.stopPropagation())
      return el
    },
  }
})

import { AccountTerminalDialog } from './AccountTerminalDialog'
import { toasts, setToasts } from '../store/ui'
import { initTerminalListeners, registerXterm, getXtermEntry } from '../store/terminals'

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
  for (const handler of [...(mocks.handlers['pty-exited'] ?? [])]) handler({ payload: { terminalId, exitCode } })
}

function open(action: 'login' | 'logout' = 'login', onClose: () => void = () => {}) {
  return render(() => <AccountTerminalDialog account={account} action={action} onClose={onClose} />)
}

beforeEach(() => {
  for (const event of Object.keys(mocks.handlers)) delete mocks.handlers[event]
  mocks.order.length = 0
  mocks.listenReady.promise = Promise.resolve()
  mocks.startAccountTerminal.mockReset()
  mocks.startAccountTerminal.mockImplementation(async () => {
    mocks.order.push('start')
    return { terminalId: 't1', hint: null }
  })
  mocks.ptyClose.mockReset()
  mocks.ptyClose.mockResolvedValue(undefined)
  mocks.ptyListen.mockReset()
  mocks.ptyListen.mockResolvedValue(undefined)
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

  test('shows Done after the login terminal exits, with the terminal still there to read', async () => {
    open('login')
    await flush()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByText('The command has ended.')).toBeNull()

    exit('t1')
    await flush()

    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.getByText('The command has ended.')).toBeTruthy()
    // What the command printed stays on screen until the dialog is dismissed.
    expect(screen.getByTestId('shell-terminal').getAttribute('data-terminal-id')).toBe('t1')
  })

  test('an ended command takes no more input', async () => {
    open('login')
    await flush()
    expect(screen.getByTestId('shell-terminal').getAttribute('data-stopped')).toBe('false')

    exit('t1')
    await flush()

    expect(screen.getByTestId('shell-terminal').getAttribute('data-stopped')).toBe('true')
  })

  test('the status line sits with Done, below the terminal', async () => {
    open('login')
    await flush()

    exit('t1')
    await flush()

    const terminal = screen.getByTestId('shell-terminal')
    const status = screen.getByText('The command has ended.')
    const done = screen.getByRole('button', { name: 'Done' })
    expect(terminal.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(status.parentElement).toBe(done.parentElement)
  })

  test('a command that failed says with which exit code', async () => {
    open('login')
    await flush()

    exit('t1', 127)
    await flush()

    expect(screen.getByText('The command ended with exit code 127.')).toBeTruthy()
    expect(screen.queryByText('The command has ended.')).toBeNull()
    expect(screen.getByTestId('shell-terminal')).toBeTruthy()
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
    // Shown all the same: the backend replays what the command printed to a terminal that attaches late.
    expect(screen.getByTestId('shell-terminal').getAttribute('data-terminal-id')).toBe('t1')
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
    expect(mocks.handlers['pty-exited']).toHaveLength(1)

    view.unmount()
    await flush()

    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    expect(mocks.handlers['pty-exited']).toHaveLength(0)
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

  describe('Escape in the terminal', () => {
    test('typed into a running command is for the command: the dialog stays', async () => {
      const onClose = vi.fn()
      open('login', onClose)
      await flush()

      fireEvent.keyDown(screen.getByTestId('shell-terminal'), { key: 'Escape' })

      expect(onClose).not.toHaveBeenCalled()
      expect(mocks.ptyClose).not.toHaveBeenCalled()
    })

    test('typed into the terminal of an ended command closes the dialog, like anywhere else', async () => {
      const onClose = vi.fn()
      open('login', onClose)
      await flush()
      exit('t1')
      await flush()

      fireEvent.keyDown(screen.getByTestId('shell-terminal'), { key: 'Escape' })

      expect(onClose).toHaveBeenCalledOnce()
      expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    })

    test('no other key closes the dialog, typed anywhere, before or after the command ends', async () => {
      const onClose = vi.fn()
      open('login', onClose)
      await flush()
      const terminal = screen.getByTestId('shell-terminal')
      const cancel = screen.getByRole('button', { name: 'Cancel' })

      for (const key of ['a', 'Enter', 'Tab', 'ArrowDown', ' ']) {
        fireEvent.keyDown(document.body, { key })
        fireEvent.keyDown(cancel, { key })
        fireEvent.keyDown(terminal, { key })
      }
      exit('t1')
      await flush()
      for (const key of ['a', 'Enter', 'Tab']) {
        fireEvent.keyDown(document.body, { key })
        fireEvent.keyDown(terminal, { key })
      }

      expect(onClose).not.toHaveBeenCalled()
      expect(mocks.ptyClose).not.toHaveBeenCalled()
    })

    test('a dialog that is gone no longer listens for it', async () => {
      const onClose = vi.fn()
      const view = open('login', onClose)
      await flush()
      view.unmount()

      fireEvent.keyDown(document.body, { key: 'Escape' })

      expect(onClose).not.toHaveBeenCalled()
    })

    test('typed outside the terminal closes the dialog, running or not', async () => {
      const onClose = vi.fn()
      open('login', onClose)
      await flush()

      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })

      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  test('closing before the listener is registered starts nothing and leaves no listener', async () => {
    let registered!: () => void
    mocks.listenReady.promise = new Promise<void>((resolve) => { registered = resolve })
    const view = open('login')
    view.unmount()

    registered()
    await flush()

    expect(mocks.startAccountTerminal).not.toHaveBeenCalled()
    expect(mocks.handlers['pty-exited']).toHaveLength(0)
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

  // The terminal store disposes the xterm of a terminal when its process ends,
  // unless the terminal was kept. The dialog keeps its own and disposes it when
  // it is dismissed. These run with the store's own exit handler, and a stand-in
  // for what ShellTerminal does when it mounts: it puts its xterm in the store.
  describe('its terminal in the terminal store', () => {
    const mountXterm = (terminalId: string) => {
      const term = { dispose: vi.fn(), write: vi.fn(), rows: 24, cols: 80 }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerXterm(terminalId, term as any, { fit: vi.fn() } as any)
      return term
    }

    beforeEach(async () => {
      await initTerminalListeners()
    })

    test('keeps the xterm after the command ends, and disposes it when Done is pressed', async () => {
      open('login')
      await flush()
      const term = mountXterm('t1')

      exit('t1', 1)
      await flush()
      expect(term.dispose).not.toHaveBeenCalled()
      expect(getXtermEntry('t1')?.term).toBe(term)

      fireEvent.click(screen.getByRole('button', { name: 'Done' }))

      expect(term.dispose).toHaveBeenCalledOnce()
      expect(getXtermEntry('t1')).toBeUndefined()
      expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
    })

    test('disposes the xterm of a command that still runs when the dialog is dismissed, once', async () => {
      open('login')
      await flush()
      const term = mountXterm('t1')

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      // The closed PTY's exit arrives afterwards, to a terminal nobody keeps any more.
      exit('t1', 137)
      await flush()

      expect(term.dispose).toHaveBeenCalledOnce()
      expect(getXtermEntry('t1')).toBeUndefined()
    })

    test('disposes the xterm when the dialog is taken away without being dismissed', async () => {
      const view = open('login')
      await flush()
      const term = mountXterm('t1')
      exit('t1')

      view.unmount()

      expect(term.dispose).toHaveBeenCalledOnce()
      expect(getXtermEntry('t1')).toBeUndefined()
    })

    test('keeps the xterm of a command that ended before the terminal was shown', async () => {
      let started!: (terminal: { terminalId: string; hint: string | null }) => void
      mocks.startAccountTerminal.mockReturnValue(new Promise((resolve) => { started = resolve }))
      open('login')
      await flush()

      // It ended before the dialog knew its id: there was no xterm for the store to dispose.
      exit('t1', 127)
      started({ terminalId: 't1', hint: null })
      await flush()
      const term = mountXterm('t1')
      await flush()

      expect(term.dispose).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(term.dispose).toHaveBeenCalledOnce()
    })

    test('does not keep a terminal that was dismissed before it existed', async () => {
      let started!: (terminal: { terminalId: string; hint: string | null }) => void
      mocks.startAccountTerminal.mockReturnValue(new Promise((resolve) => { started = resolve }))
      open('login')
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      started({ terminalId: 't1', hint: null })
      await flush()

      // Whatever mounts an xterm for it now is an ordinary terminal: its exit disposes it.
      const term = mountXterm('t1')
      exit('t1')

      expect(term.dispose).toHaveBeenCalledOnce()
    })

    test('leaves every other terminal to the store as before', async () => {
      open('login')
      await flush()
      const mine = mountXterm('t1')
      const shell = mountXterm('some-shell')

      exit('some-shell')

      expect(shell.dispose).toHaveBeenCalledOnce()
      expect(mine.dispose).not.toHaveBeenCalled()
    })
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
