import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('../store/agents', () => ({ agents: [
  { id: 'claude', name: 'Claude Code', installed: true, cliVersion: '1.0.0', supportsModelSelection: true, models: [{ id: 'opus', label: 'Opus', description: 'Deep work' }, { id: 'future', label: 'Future', description: '', minVersion: '9.0.0' }] },
  { id: 'codex', name: 'Codex', installed: true, supportsModelSelection: true, models: [{ id: 'gpt', label: 'GPT', description: 'Coding' }] },
  { id: 'gemini', name: 'Gemini', installed: false, models: [] },
  { id: 'cursor', name: 'Cursor', installed: true, supportsModelSelection: false, models: [] },
] }))
import { HarnessModelPicker } from './HarnessModelPicker'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'
afterEach(cleanup)
test('browsing harnesses only commits a choice when a model is selected', () => {
  const pick = vi.fn()
  render(() => <HarnessModelPicker agent="claude" onPick={pick} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
  expect(pick).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Opus' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'GPT' }))
  expect(pick).toHaveBeenCalledWith('codex', 'gpt', undefined)
  expect(screen.queryByRole('dialog')).toBeNull()
})
test('uninstalled harnesses and models requiring newer CLIs cannot be selected', () => {
  render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  expect((screen.getByRole('button', { name: /Gemini/ }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: /Future/ }) as HTMLButtonElement).disabled).toBe(true)
})
test('harnesses without model selection use their CLI default', () => {
  const pick = vi.fn()
  render(() => <HarnessModelPicker agent="claude" onPick={pick} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cursor' }))
  fireEvent.click(screen.getByRole('button', { name: /CLI default/ }))
  expect(pick).toHaveBeenCalledWith('cursor', undefined, undefined)
})

test('search filters models and Escape cancels browsing and restores focus', () => {
  const pick = vi.fn()
  render(() => <HarnessModelPicker agent="claude" onPick={pick} />)
  const trigger = screen.getByRole('button', { name: 'Choose model: Opus' })
  fireEvent.click(trigger)
  fireEvent.input(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'missing' } })
  expect(screen.getByText('No matching models.')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(pick).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
})

test('keeps the picker free of redundant headings', () => {
  render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose model: Opus' }))
  expect(screen.queryByText('Harnesses')).toBeNull()
  expect(screen.getAllByText('Claude Code')).toHaveLength(1)
  expect(screen.getByRole('textbox', { name: 'Search models' })).toBeTruthy()
})

// A harness with added accounts is one row per account in the list of harnesses
// (`Claude Code · Acme`, with its color), and a model picked under a row is for
// that account. The trigger names the account unless it is Default. A harness
// without accounts is the picker above, and picks without an account.
describe('<HarnessModelPicker /> with accounts', () => {
  const acme = makeAccount()
  const beta = makeAccount({ id: 'a2', label: 'Beta', color: '#16a34a' })
  const work = makeAccount({ id: 'c1', agentType: 'codex', label: 'Work', color: '#ea580c' })
  const betaForP1 = { projectId: 'p1', agentType: 'claude' as const, accountId: 'a2' }

  beforeEach(() => applySnapshot(makeSnapshot({ accounts: [acme, beta] })))
  afterEach(() => applySnapshot(makeSnapshot()))

  const openPicker = (name = 'Choose model: Opus') => fireEvent.click(screen.getByRole('button', { name }))
  /** The harness rows on the left of the open picker: its first child, before the models. */
  const harnessList = () => screen.getByRole('dialog').firstElementChild as HTMLElement
  const harnessRows = () => Array.from(harnessList().querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
  const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

  test('picking an account row passes the selection', () => {
    const pick = vi.fn()
    render(() => <HarnessModelPicker agent="claude" projectId="p1" onPick={pick} />)

    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Acme' }))
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }))

    expect(pick).toHaveBeenCalledWith('claude', 'opus', { kind: 'account', id: 'a1' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('picking the Default row passes Default, even for a project that uses an account', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [betaForP1] }))
    const pick = vi.fn()
    render(() => <HarnessModelPicker agent="claude" projectId="p1" onPick={pick} />)

    openPicker('Choose model: Opus · Beta')
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Default' }))
    fireEvent.click(screen.getByRole('button', { name: 'Opus' }))

    expect(pick).toHaveBeenCalledWith('claude', 'opus', { kind: 'default' })
  })

  test('a harness without accounts is still one row and picks without an account', () => {
    const pick = vi.fn()
    render(() => <HarnessModelPicker agent="claude" onPick={pick} />)

    openPicker()
    expect(harnessRows()).toContain('Codex')
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'GPT' }))

    expect(pick).toHaveBeenCalledWith('codex', 'gpt', undefined)
  })

  test('each account is its own row, the project account first', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [betaForP1] }))
    render(() => <HarnessModelPicker agent="claude" projectId="p1" onPick={() => {}} />)

    openPicker('Choose model: Opus · Beta')

    expect(harnessRows()).toEqual(['Claude Code · Beta', 'Claude Code · Default', 'Claude Code · Acme', 'Codex', 'Gemini', 'Cursor'])
  })

  test('Default leads for a project that uses none', () => {
    render(() => <HarnessModelPicker agent="claude" projectId="p1" onPick={() => {}} />)

    openPicker()

    expect(harnessRows()).toEqual(['Claude Code · Default', 'Claude Code · Acme', 'Claude Code · Beta', 'Codex', 'Gemini', 'Cursor'])
  })

  test('accounts of another harness give this one no rows', () => {
    applySnapshot(makeSnapshot({ accounts: [work] }))
    render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)

    openPicker()

    expect(harnessRows()).toEqual(['Claude Code', 'Codex · Default', 'Codex · Work', 'Gemini', 'Cursor'])
  })

  test('an account has its color, Default has none', () => {
    render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)

    openPicker()

    expect(within(screen.getByRole('button', { name: 'Claude Code · Default' })).queryByTestId('account-color')).toBeNull()
    const dot = within(screen.getByRole('button', { name: 'Claude Code · Acme' })).getByTestId('account-color')
    expect(dot.style.backgroundColor).toBe('rgb(124, 58, 237)')
    expect(within(screen.getByRole('button', { name: 'Codex' })).queryByTestId('account-color')).toBeNull()
  })

  test('the Default row says who the harness is signed in as', () => {
    applySnapshot(makeSnapshot({
      accounts: [acme],
      defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'signedIn', email: 'me@home.dev' }) }],
    }))
    render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)

    openPicker()

    expect(screen.getByRole('button', { name: 'Claude Code · Default' }).textContent).toContain('me@home.dev')
    expect(screen.getByRole('button', { name: 'Claude Code · Acme' }).textContent).not.toContain('me@home.dev')
  })

  test('the list keeps its width until a harness has accounts', () => {
    applySnapshot(makeSnapshot())
    render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)
    openPicker()
    expect(harnessList().classList.contains('w-34')).toBe(true)
    cleanup()

    applySnapshot(makeSnapshot({ accounts: [acme] }))
    render(() => <HarnessModelPicker agent="claude" onPick={() => {}} />)
    openPicker()
    expect(harnessList().classList.contains('w-34')).toBe(false)
  })

  describe('the trigger', () => {
    test.each([
      ['an account', { kind: 'account', id: 'a1' }, 'Choose model: Opus · Acme'],
      ['Default', { kind: 'default' }, 'Choose model: Opus'],
      ['the project default of a project with no account', { kind: 'projectDefault' }, 'Choose model: Opus'],
      ['no choice yet', undefined, 'Choose model: Opus'],
    ] as const)('for %s', (_, account, name) => {
      render(() => <HarnessModelPicker agent="claude" projectId="p1" account={account} onPick={() => {}} />)

      expect(screen.getByRole('button', { name })).toBeTruthy()
    })

    test('names the account the project uses when none is chosen', () => {
      applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [betaForP1] }))
      render(() => <HarnessModelPicker agent="claude" projectId="p1" onPick={() => {}} />)

      expect(screen.getByRole('button', { name: 'Choose model: Opus · Beta' })).toBeTruthy()
    })

    test('is the project default for another project', () => {
      applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [betaForP1] }))
      render(() => <HarnessModelPicker agent="claude" projectId="p2" onPick={() => {}} />)

      expect(screen.getByRole('button', { name: 'Choose model: Opus' })).toBeTruthy()
    })

    test('falls back to the project default when the account is no longer offered', () => {
      applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [betaForP1] }))
      render(() => <HarnessModelPicker agent="claude" projectId="p1" account={{ kind: 'account', id: 'gone' }} onPick={() => {}} />)

      expect(screen.getByRole('button', { name: 'Choose model: Opus · Beta' })).toBeTruthy()
    })

    test('does not name an account of a harness that has none', () => {
      render(() => <HarnessModelPicker agent="codex" account={{ kind: 'account', id: 'a1' }} onPick={() => {}} />)

      expect(screen.getByRole('button', { name: 'Choose model: GPT' })).toBeTruthy()
    })
  })

  test('opens on the row of the current account, and the model is checked only there', () => {
    render(() => <HarnessModelPicker agent="claude" account={{ kind: 'account', id: 'a1' }} onPick={() => {}} />)

    openPicker('Choose model: Opus · Acme')
    expect(pressed('Claude Code · Acme')).toBe('true')
    expect(pressed('Claude Code · Default')).toBe('false')
    expect(pressed('Opus')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Default' }))
    expect(pressed('Claude Code · Default')).toBe('true')
    expect(pressed('Opus')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Acme' }))
    expect(pressed('Opus')).toBe('true')
  })

  test('browsing another account commits nothing', () => {
    const pick = vi.fn()
    render(() => <HarnessModelPicker agent="claude" onPick={pick} />)

    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code · Beta' }))

    expect(pick).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  test('a harness that cannot choose models uses its CLI default under its account', () => {
    applySnapshot(makeSnapshot({ accounts: [makeAccount({ id: 'k1', agentType: 'cursor', label: 'Key' })] }))
    const pick = vi.fn()
    render(() => <HarnessModelPicker agent="claude" onPick={pick} />)

    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Cursor · Key' }))
    fireEvent.click(screen.getByRole('button', { name: /CLI default/ }))

    expect(pick).toHaveBeenCalledWith('cursor', undefined, { kind: 'account', id: 'k1' })
  })
})
