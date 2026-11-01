import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

// Stub the terminals store: TerminalPanel reads from it but for this test we
// only care about the chrome around the empty state, so an empty list suffices.
const terminalsMocks = vi.hoisted(() => {
  // Loosely typed: the tests below give these other shapes than the defaults.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (impl?: (...args: any[]) => any) => vi.fn<(...args: any[]) => any>(impl)
  return {
    terminalsForTask: fn(() => []),
    activeTerminalId: fn(() => undefined),
    setActiveTerminalForTask: fn(),
    spawnTerminal: fn(() => Promise.resolve()),
    closeTerminal: fn(() => Promise.resolve()),
    focusActiveTerminal: fn(),
    terminalExitCodes: fn(() => ({})),
    isTerminalStopped: fn(() => false),
    spawnStartCommand: fn(() => Promise.resolve()),
    // Treat the task as hydrated but with no terminals so the createEffect that
    // would auto-spawn one is gated by the empty terminals + spawning guard.
    isTaskHydrated: fn(() => false),
  }
})
vi.mock('../store/terminals', () => terminalsMocks)

const setupMocks = vi.hoisted(() => ({ isSetupRunning: vi.fn<(taskId: string) => boolean>(() => false) }))
vi.mock('../store/setup', () => setupMocks)

vi.mock('../lib/ipc', () => ({
  stopHook: vi.fn(() => Promise.resolve()),
  runHook: vi.fn(() => Promise.resolve()),
  ptyClose: vi.fn(() => Promise.resolve()),
}))

// xterm needs a real DOM and WebGL — neither of which jsdom supplies. Stub the
// terminal so the panel can mount and we can inspect its outer chrome.
vi.mock('./ShellTerminal', () => ({
  ShellTerminal: () => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'shell-terminal')
    return el
  },
}))

import { TerminalPanel } from './TerminalPanel'
import * as ipc from '../lib/ipc'
import { toasts, setToasts } from '../store/ui'
import type { TerminalInstance } from '../types'

beforeEach(() => {
  cleanup()
  // Back to the defaults above (an empty, not yet hydrated task) for every test.
  for (const mock of Object.values(terminalsMocks)) mock.mockReset()
  setupMocks.isSetupRunning.mockReset()
  vi.mocked(ipc.runHook).mockReset()
  setToasts([])
})

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('TerminalPanel chrome adapts to the theme', () => {
  // Regression: the panel container baked in `bg-[#0a0a0a]`, leaving the empty
  // state and any gaps around the xterm canvas stuck on a black background
  // even after the user switched to light mode. Surface tokens flip with the
  // theme; raw hex does not.
  test('outer container uses a surface token, not a hardcoded dark hex', () => {
    const { container } = render(() => <TerminalPanel taskId="t-1" />)
    const outer = container.firstElementChild as HTMLElement
    expect(outer).toBeTruthy()
    const cls = outer.className
    expect(cls).not.toMatch(/bg-\[#0a0a0a\]/)
    expect(cls).toMatch(/bg-surface-0\b/)
  })
})

// A project whose accounts can't be read makes every terminal spawn fail with an
// account error. The store shows it as its toast and resolves null; the panel
// must then leave the task without a terminal rather than ask again, which
// would repeat the toast (and the keychain prompt behind it) for ever.
describe('TerminalPanel opening its first terminal', () => {
  /** The task's terminals as a signal, the way the store has them. */
  function terminalList(initial: TerminalInstance[] = []) {
    const [list, setList] = createSignal(initial)
    terminalsMocks.terminalsForTask.mockImplementation(() => list())
    return { list, setList }
  }

  /** A spawn that settles for its first `limit` calls and then never does, so a retry loop ends the test instead of running away. */
  function spawnsThatStopAfter(limit: number, outcome: () => Promise<unknown>) {
    let calls = 0
    return () => (++calls <= limit ? outcome() : new Promise(() => {}))
  }

  beforeEach(() => {
    terminalsMocks.isTaskHydrated.mockReturnValue(true)
  })

  test('opens one when the task has none', async () => {
    const { setList } = terminalList()
    terminalsMocks.spawnTerminal.mockImplementation(() => {
      const instance = { id: 'p-1', taskId: 't-1', name: 'zsh' }
      setList([instance])
      return Promise.resolve(instance)
    })

    render(() => <TerminalPanel taskId="t-1" />)
    await settle()

    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledTimes(1)
    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledWith('t-1', 24, 80)
  })

  test('tries once and stays empty when the account stops the spawn', async () => {
    terminalList()
    terminalsMocks.spawnTerminal.mockImplementation(spawnsThatStopAfter(3, () => Promise.resolve(null)))

    const { getByText } = render(() => <TerminalPanel taskId="t-1" />)
    await settle()

    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledTimes(1)
    expect(getByText('No terminals open')).toBeTruthy()
  })

  test('tries the start command once when the account stops it', async () => {
    terminalList()
    terminalsMocks.spawnStartCommand.mockImplementation(spawnsThatStopAfter(3, () => Promise.resolve(null)))

    render(() => <TerminalPanel taskId="t-1" startCommand="pnpm dev" autoStart />)
    await settle()

    expect(terminalsMocks.spawnStartCommand).toHaveBeenCalledTimes(1)
    expect(terminalsMocks.spawnStartCommand).toHaveBeenCalledWith('t-1', 'pnpm dev')
    expect(terminalsMocks.spawnTerminal).not.toHaveBeenCalled()
  })

  test('the new-terminal button still asks again after the account stopped it', async () => {
    terminalList()
    terminalsMocks.spawnTerminal.mockImplementation(spawnsThatStopAfter(3, () => Promise.resolve(null)))
    const { getByTitle } = render(() => <TerminalPanel taskId="t-1" />)
    await settle()
    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledTimes(1)

    fireEvent.click(getByTitle('New Terminal'))
    await settle()

    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledTimes(2)
  })

  test('opens a fresh one when the last terminal is gone', async () => {
    // The auto-open follows the terminals: it must still run when they go from some to none.
    const { setList } = terminalList([{ id: 'p-1', taskId: 't-1', name: 'zsh' }])
    terminalsMocks.spawnTerminal.mockImplementation(() => {
      const instance = { id: 'p-2', taskId: 't-1', name: 'zsh' }
      setList([instance])
      return Promise.resolve(instance)
    })
    render(() => <TerminalPanel taskId="t-1" />)
    await settle()
    expect(terminalsMocks.spawnTerminal).not.toHaveBeenCalled()

    setList([])
    await settle()

    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledTimes(1)
  })

  test('waits for setup to finish, then opens one', async () => {
    const { setList } = terminalList()
    const [running, setRunning] = createSignal(true)
    setupMocks.isSetupRunning.mockImplementation(() => running())
    terminalsMocks.spawnTerminal.mockImplementation(() => {
      const instance = { id: 'p-1', taskId: 't-1', name: 'zsh' }
      setList([instance])
      return Promise.resolve(instance)
    })
    render(() => <TerminalPanel taskId="t-1" />)
    await settle()
    expect(terminalsMocks.spawnTerminal).not.toHaveBeenCalled()

    setRunning(false)
    await settle()

    expect(terminalsMocks.spawnTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalPanel re-running a hook', () => {
  const secret = 'ACCOUNT_ERROR:{"kind":"secret","accountId":"a1","label":"Acme","projects":[],"message":"ANTHROPIC_API_KEY has no stored value"}'
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    terminalsMocks.terminalsForTask.mockReturnValue([{ id: 'hook-1', taskId: 't-1', name: 'Setup', hookType: 'setup' }])
    terminalsMocks.isTerminalStopped.mockReturnValue(true)
    terminalsMocks.terminalExitCodes.mockReturnValue({ 'hook-1': 1 })
  })
  afterEach(() => consoleError.mockRestore())

  test('a hook the account stopped is shown as its toast, not logged', async () => {
    vi.mocked(ipc.runHook).mockRejectedValueOnce(secret)
    const { getByTitle } = render(() => <TerminalPanel taskId="t-1" />)

    fireEvent.click(getByTitle('Re-run hook'))
    await settle()

    expect(ipc.runHook).toHaveBeenCalledWith('t-1', 'setup')
    expect(toasts().map(t => ({ title: t.title, message: t.message }))).toEqual([
      { title: 'Keychain error', message: "Couldn't read a secret for Acme from the keychain." },
    ])
    expect(consoleError).not.toHaveBeenCalled()
  })

  test('any other failure is logged, as before, with no toast', async () => {
    vi.mocked(ipc.runHook).mockRejectedValueOnce('Hook failed to start')
    const { getByTitle } = render(() => <TerminalPanel taskId="t-1" />)

    fireEvent.click(getByTitle('Re-run hook'))
    await settle()

    expect(consoleError).toHaveBeenCalledWith('Failed to re-run hook:', 'Hook failed to start')
    expect(toasts()).toEqual([])
  })

  test('a hook that starts shows nothing', async () => {
    vi.mocked(ipc.runHook).mockResolvedValueOnce({ terminalId: 'hook-2', shellName: 'sh' })
    const { getByTitle } = render(() => <TerminalPanel taskId="t-1" />)

    fireEvent.click(getByTitle('Re-run hook'))
    await settle()

    expect(consoleError).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })
})
