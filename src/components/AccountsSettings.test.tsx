import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@solidjs/testing-library'
import { reconcile } from 'solid-js/store'

// Settings -> Accounts: per installed harness, the Default login and the added
// accounts, with the buttons that log them in and out, edit them and remove them.
// The list is the accounts store; the commands' own snapshots never reach it.
const mocks = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  removeAccount: vi.fn(),
  startAccountTerminal: vi.fn(),
  ptyClose: vi.fn(),
  exitedHandlers: [] as Array<(event: { payload: { terminalId: string; exitCode?: number | null } }) => void>,
}))
vi.mock('../lib/ipc', () => ({
  listAccounts: mocks.listAccounts,
  createAccount: mocks.createAccount,
  updateAccount: mocks.updateAccount,
  removeAccount: mocks.removeAccount,
  startAccountTerminal: mocks.startAccountTerminal,
  ptyClose: mocks.ptyClose,
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_event: string, handler: (event: { payload: { terminalId: string } }) => void) => {
    mocks.exitedHandlers.push(handler)
    return Promise.resolve(() => {
      const i = mocks.exitedHandlers.indexOf(handler)
      if (i !== -1) mocks.exitedHandlers.splice(i, 1)
    })
  }),
  emit: vi.fn(),
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

import { AccountsSettings } from './AccountsSettings'
import { setAgents } from '../store/agents'
import { accountsState, applySnapshot } from '../store/accounts'
import { toasts, setToasts } from '../store/ui'
import type { Account, AccountIdentity, AccountSupport, AccountsSnapshot, AgentInfo, AgentType } from '../types'

const inUse = 'ACCOUNT_ERROR:{"kind":"inUse","accountId":"a1","label":"Acme","projects":["Alpha","Beta"],"message":null}'

const makeSupport = (overrides: Partial<AccountSupport> = {}): AccountSupport => ({
  login: true,
  logout: true,
  existingDir: true,
  requiredSecret: null,
  loginHint: null,
  logoutHint: null,
  minCliVersion: null,
  blockedReason: null,
  ...overrides,
})

const makeAgent = (id: AgentType, name: string, overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name,
  installHint: '',
  updateHint: '',
  docsUrl: '',
  models: [],
  installed: true,
  cliVersion: '2.1.304',
  supportsStreaming: true,
  supportsResume: true,
  supportsPlanMode: true,
  supportsModelSelection: true,
  supportsEffort: true,
  supportsSkills: true,
  supportsAttachments: true,
  supportsFork: true,
  accountSupport: makeSupport(),
  ...overrides,
})

const makeIdentity = (overrides: Partial<AccountIdentity> = {}): AccountIdentity => ({
  status: 'signedOut',
  email: null,
  orgName: null,
  plan: null,
  providers: [],
  ...overrides,
})

const signedIn = makeIdentity({ status: 'signedIn', email: 'dev@acme.com', orgName: 'Acme Inc', plan: 'Max' })

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: 'a1',
  agentType: 'claude',
  label: 'Acme',
  color: '#7c3aed',
  configDir: '/data/accounts/a1',
  managedDir: true,
  env: [],
  removedAt: null,
  createdAt: 1000,
  identity: signedIn,
  ...overrides,
})

const claudeDefault = { agentType: 'claude' as const, identity: makeIdentity({ status: 'signedIn', email: 'me@home.dev', plan: 'Pro' }) }

/** What the toasts say, as `type: message`. */
const shown = () => toasts().map((t) => `${t.type}: ${t.message}`)

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/** Puts the harnesses and accounts in the stores and has the mount-time read return the same. */
function show(snapshot: Partial<AccountsSnapshot> = {}, agents: AgentInfo[] = [makeAgent('claude', 'Claude Code')]) {
  const full: AccountsSnapshot = { accounts: [], defaults: [claudeDefault], projectAccounts: [], ...snapshot }
  setAgents(reconcile(agents))
  applySnapshot(full)
  mocks.listAccounts.mockResolvedValue(full)
  return render(() => <AccountsSettings />)
}

const group = (name: string) => within(screen.getByRole('region', { name }))
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  mocks.exitedHandlers.length = 0
  for (const mock of [mocks.listAccounts, mocks.createAccount, mocks.updateAccount, mocks.removeAccount, mocks.startAccountTerminal, mocks.ptyClose]) mock.mockReset()
  mocks.startAccountTerminal.mockResolvedValue({ terminalId: 't1', hint: null })
  mocks.ptyClose.mockResolvedValue(undefined)
  mocks.removeAccount.mockResolvedValue({ accounts: [], defaults: [], projectAccounts: [] })
  setAgents(reconcile([]))
  applySnapshot({ accounts: [], defaults: [], projectAccounts: [] })
  setToasts([])
})

afterEach(() => cleanup())

describe('AccountsSettings list', () => {
  test('lists the default row and live accounts per supported harness', async () => {
    const acme = makeAccount()
    const beta = makeAccount({
      id: 'a2',
      label: 'Beta',
      color: '#0ea5e9',
      configDir: '/Users/me/.claude-beta',
      managedDir: false,
      identity: makeIdentity(),
    })
    const old = makeAccount({ id: 'a3', label: 'Old', removedAt: 5 })
    show({ accounts: [acme, beta, old] }, [
      makeAgent('claude', 'Claude Code'),
      makeAgent('codex', 'Codex', { accountSupport: null }),
    ])
    await flush()

    // One group for the harness with account support, none for the other.
    expect(screen.getAllByRole('region')).toHaveLength(1)
    const claude = group('Claude Code')
    expect(screen.queryByRole('region', { name: 'Codex' })).toBeNull()

    // Default first, with who it is signed in as.
    const rows = claude.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('Default')).toBeTruthy()
    expect(within(rows[0]).getByText('me@home.dev · Pro')).toBeTruthy()

    // A card per live account: label, identity and the folder it lives in.
    expect(within(rows[1]).getByText('Acme')).toBeTruthy()
    expect(within(rows[1]).getByText('dev@acme.com · Acme Inc · Max')).toBeTruthy()
    expect(within(rows[1]).getByText('/data/accounts/a1')).toBeTruthy()
    expect(within(rows[2]).getByText('Beta')).toBeTruthy()
    expect(within(rows[2]).getByText('Signed out')).toBeTruthy()
    expect(within(rows[2]).getByText('/Users/me/.claude-beta')).toBeTruthy()

    // A removed account is not listed.
    expect(screen.queryByText('Old')).toBeNull()
  })

  test('a card shows its color', async () => {
    show({ accounts: [makeAccount({ color: '#0ea5e9' })] })
    await flush()

    expect(screen.getByTestId('account-color').style.backgroundColor).toBe('rgb(14, 165, 233)')
  })

  test('says why nobody is signed in', async () => {
    show({
      accounts: [
        makeAccount({ id: 'a1', label: 'Keyed', identity: makeIdentity({ status: 'apiKey' }) }),
        makeAccount({ id: 'a2', label: 'Unreadable', identity: makeIdentity({ status: 'unknown' }) }),
        makeAccount({ id: 'a3', label: 'Providers', identity: makeIdentity({ status: 'signedIn', providers: ['anthropic', 'openai'] }) }),
        makeAccount({ id: 'a4', label: 'Nameless', identity: makeIdentity({ status: 'signedIn' }) }),
      ],
      defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'unknown' }) }],
    })
    await flush()

    const row = (label: string) => within(screen.getByText(label).closest('li')!)
    expect(row('Keyed').getByText('API key')).toBeTruthy()
    expect(row('Unreadable').getByText('Status unknown')).toBeTruthy()
    expect(row('Providers').getByText('anthropic, openai')).toBeTruthy()
    expect(row('Nameless').getByText('Signed in')).toBeTruthy()
    // The Default row says so too when the snapshot cannot tell.
    expect(row('Default').getByText('Status unknown')).toBeTruthy()
  })

  test('the Default row is read-only', async () => {
    show()
    await flush()

    const row = group('Claude Code').getAllByRole('listitem')[0]
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
  })

  test('reads the accounts on mount, so every identity is fresh', async () => {
    show({ accounts: [makeAccount()] })
    await flush()

    expect(mocks.listAccounts).toHaveBeenCalledOnce()
  })

  test('follows the store: a changed identity shows without a reload', async () => {
    show({ accounts: [makeAccount({ identity: makeIdentity() })] })
    await flush()
    expect(screen.getByText('Signed out')).toBeTruthy()

    // What the accounts-changed event does after a login terminal ends.
    applySnapshot({ accounts: [makeAccount({ identity: signedIn })], defaults: [claudeDefault], projectAccounts: [] })

    expect(screen.queryByText('Signed out')).toBeNull()
    expect(screen.getByText('dev@acme.com · Acme Inc · Max')).toBeTruthy()
  })

  test('a harness without account support has no group, and nothing installed says so', async () => {
    show({}, [makeAgent('codex', 'Codex', { accountSupport: null }), makeAgent('claude', 'Claude Code', { installed: false })])
    await flush()

    expect(screen.queryAllByRole('region')).toHaveLength(0)
    expect(screen.getByText('None of your installed agents support added accounts.')).toBeTruthy()
  })

  describe('a harness that is not installed', () => {
    const cursor = makeAgent('cursor', 'Cursor', { installed: false, cliVersion: undefined })

    test('has no group while it has no accounts', async () => {
      show({}, [cursor])
      await flush()

      expect(screen.queryByRole('region', { name: 'Cursor' })).toBeNull()
    })

    test('still lists the accounts it has, to edit or remove, but offers nothing that needs the CLI', async () => {
      show({ accounts: [makeAccount({ agentType: 'cursor', label: 'Legacy' })] }, [cursor])
      await flush()

      const cursorGroup = group('Cursor')
      expect(cursorGroup.getByText('Not installed')).toBeTruthy()
      expect(cursorGroup.getByText('Legacy')).toBeTruthy()
      expect(cursorGroup.getByRole('button', { name: 'Edit Legacy' })).toBeTruthy()
      expect(cursorGroup.getByRole('button', { name: 'Remove Legacy' })).toBeTruthy()
      expect(cursorGroup.queryByRole('button', { name: 'Log in to Legacy' })).toBeNull()
      expect(cursorGroup.queryByRole('button', { name: 'Log out of Legacy' })).toBeNull()
      expect(cursorGroup.queryByRole('button', { name: 'Add account' })).toBeNull()
      // Nobody can say who the CLI is signed in as when there is no CLI.
      expect(cursorGroup.queryByText('Default')).toBeNull()
    })
  })
})

describe('AccountsSettings add account', () => {
  test('opens the dialog for the harness', async () => {
    show()
    await flush()

    fireEvent.click(group('Claude Code').getByRole('button', { name: 'Add account' }))

    expect(screen.getByRole('heading', { name: 'Add Claude Code account' })).toBeTruthy()
  })

  test('adding an account closes the dialog and leaves the list to the store', async () => {
    show()
    await flush()
    mocks.createAccount.mockResolvedValue({ accounts: [makeAccount()], defaults: [], projectAccounts: [] })

    fireEvent.click(group('Claude Code').getByRole('button', { name: 'Add account' }))
    fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'Acme' } })
    fireEvent.click(within(screen.getByRole('heading', { name: 'Add Claude Code account' }).parentElement!).getByRole('button', { name: 'Add account' }))
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledOnce()
    expect(screen.queryByRole('heading', { name: 'Add Claude Code account' })).toBeNull()
    expect(accountsState.accounts).toEqual([])
  })

  test('is disabled with the reason the harness gives', async () => {
    show({}, [makeAgent('claude', 'Claude Code', { accountSupport: makeSupport({ blockedReason: 'Update Claude Code to use added accounts.' }) })])
    await flush()

    const add = group('Claude Code').getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(group('Claude Code').getByText('Update Claude Code to use added accounts.')).toBeTruthy()
  })

  test('is disabled when the CLI is older than the one accounts need', async () => {
    show({}, [makeAgent('claude', 'Claude Code', { cliVersion: '1.0.0', accountSupport: makeSupport({ minCliVersion: '2.0.0' }) })])
    await flush()

    const add = group('Claude Code').getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(group('Claude Code').getByText('Added accounts need Claude Code 2.0.0 or later (installed: 1.0.0).')).toBeTruthy()
  })

  test('is available once the CLI meets the version', async () => {
    show({}, [makeAgent('claude', 'Claude Code', { cliVersion: '2.1.304', accountSupport: makeSupport({ minCliVersion: '2.0.0' }) })])
    await flush()

    const add = group('Claude Code').getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(add.disabled).toBe(false)
    expect(group('Claude Code').queryByText(/Added accounts need/)).toBeNull()
  })
})

describe('AccountsSettings log in and out', () => {
  test('Log in starts a login terminal', async () => {
    show({ accounts: [makeAccount()] })
    await flush()

    click('Log in to Acme')
    await flush()

    expect(mocks.startAccountTerminal).toHaveBeenCalledWith('a1', 'login', 24, 80)
    expect(screen.getByRole('heading', { name: 'Log in to Acme' })).toBeTruthy()
    expect(screen.getByTestId('shell-terminal').getAttribute('data-terminal-id')).toBe('t1')
  })

  test('Log out starts a logout terminal', async () => {
    show({ accounts: [makeAccount()] })
    await flush()

    click('Log out of Acme')
    await flush()

    expect(mocks.startAccountTerminal).toHaveBeenCalledWith('a1', 'logout', 24, 80)
    expect(screen.getByRole('heading', { name: 'Log out of Acme' })).toBeTruthy()
  })

  test('shows Done after the login terminal exits, and Done closes it', async () => {
    show({ accounts: [makeAccount()] })
    await flush()
    click('Log in to Acme')
    await flush()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()

    for (const handler of mocks.exitedHandlers) handler({ payload: { terminalId: 't1', exitCode: 0 } })
    await flush()
    click('Done')

    expect(screen.queryByRole('heading', { name: 'Log in to Acme' })).toBeNull()
    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
  })

  test('another login being open shows the account toast', async () => {
    mocks.startAccountTerminal.mockRejectedValue('ACCOUNT_ERROR:{"kind":"busy","accountId":null,"label":null,"projects":[],"message":null}')
    show({ accounts: [makeAccount()] })
    await flush()

    click('Log in to Acme')
    await flush()

    expect(toasts().map((t) => t.title)).toEqual(['Login already open'])
  })

  test('only the commands the harness has are offered', async () => {
    show({ accounts: [makeAccount()] }, [makeAgent('claude', 'Claude Code', { accountSupport: makeSupport({ logout: false }) })])
    await flush()

    expect(screen.getByRole('button', { name: 'Log in to Acme' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Log out of Acme' })).toBeNull()
    cleanup()

    show({ accounts: [makeAccount()] }, [makeAgent('claude', 'Claude Code', { accountSupport: makeSupport({ login: false }) })])
    await flush()

    expect(screen.queryByRole('button', { name: 'Log in to Acme' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Log out of Acme' })).toBeTruthy()
  })

  test('leaving the page closes a terminal that is still running', async () => {
    const view = show({ accounts: [makeAccount()] })
    await flush()
    click('Log in to Acme')
    await flush()

    view.unmount()

    expect(mocks.ptyClose).toHaveBeenCalledWith('t1')
  })
})

describe('AccountsSettings edit', () => {
  test('Edit opens the dialog with the account', async () => {
    show({ accounts: [makeAccount({ label: 'Acme' })] })
    await flush()

    click('Edit Acme')

    expect(screen.getByRole('heading', { name: 'Edit account' })).toBeTruthy()
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Acme')
  })
})

describe('AccountsSettings remove', () => {
  const confirm = () => within(screen.getByRole('heading', { name: 'Remove Acme?' }).parentElement!)

  test('asks first, with what happens to its sessions', async () => {
    show({ accounts: [makeAccount()] })
    await flush()
    expect(screen.queryByText('Remove Acme?')).toBeNull()

    click('Remove Acme')

    expect(screen.getByRole('heading', { name: 'Remove Acme?' })).toBeTruthy()
    expect(screen.getByText("Sessions on this account keep their history but can't continue.")).toBeTruthy()
    expect(mocks.removeAccount).not.toHaveBeenCalled()
  })

  test('confirming removes the account and keeps its folder', async () => {
    show({ accounts: [makeAccount()] })
    await flush()
    click('Remove Acme')

    fireEvent.click(confirm().getByRole('button', { name: 'Remove' }))
    await flush()

    expect(mocks.removeAccount).toHaveBeenCalledWith('a1', false)
    expect(screen.queryByRole('heading', { name: 'Remove Acme?' })).toBeNull()
    expect(shown()).toEqual(['success: Removed Acme'])
    // The card goes when the accounts-changed event says so, not before.
    expect(screen.getByText('Acme')).toBeTruthy()
  })

  test('a folder Verun made can be deleted with the account', async () => {
    show({ accounts: [makeAccount({ managedDir: true })] })
    await flush()
    click('Remove Acme')

    fireEvent.click(confirm().getByLabelText('Also delete its folder'))
    fireEvent.click(confirm().getByRole('button', { name: 'Remove' }))
    await flush()

    expect(mocks.removeAccount).toHaveBeenCalledWith('a1', true)
  })

  test('a folder the user brought is never offered for deletion', async () => {
    show({ accounts: [makeAccount({ managedDir: false, configDir: '/Users/me/.claude-acme' })] })
    await flush()
    click('Remove Acme')

    expect(screen.queryByLabelText('Also delete its folder')).toBeNull()
    fireEvent.click(confirm().getByRole('button', { name: 'Remove' }))
    await flush()

    expect(mocks.removeAccount).toHaveBeenCalledWith('a1', false)
  })

  test('the folder choice does not carry over to the next removal', async () => {
    show({ accounts: [makeAccount({ id: 'a1', label: 'Acme' }), makeAccount({ id: 'a2', label: 'Beta' })] })
    await flush()
    click('Remove Acme')
    fireEvent.click(confirm().getByLabelText('Also delete its folder'))
    fireEvent.click(confirm().getByRole('button', { name: 'Cancel' }))

    click('Remove Beta')
    fireEvent.click(within(screen.getByRole('heading', { name: 'Remove Beta?' }).parentElement!).getByRole('button', { name: 'Remove' }))
    await flush()

    expect(mocks.removeAccount).toHaveBeenCalledWith('a2', false)
  })

  test('Enter confirms the question, but not when it is meant for the options in it', async () => {
    show({ accounts: [makeAccount({ identity: signedIn })] })
    await flush()
    click('Remove Acme')

    // Enter on a focused switch or button activates it. It is not "Remove".
    fireEvent.keyDown(confirm().getByLabelText('Also delete its folder'), { key: 'Enter' })
    fireEvent.keyDown(confirm().getByRole('button', { name: 'Log out first' }), { key: 'Enter' })
    await flush()
    expect(mocks.removeAccount).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Enter' })
    await flush()
    expect(mocks.removeAccount).toHaveBeenCalledWith('a1', false)
  })

  test('Cancel removes nothing', async () => {
    show({ accounts: [makeAccount()] })
    await flush()
    click('Remove Acme')

    fireEvent.click(confirm().getByRole('button', { name: 'Cancel' }))

    expect(mocks.removeAccount).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Remove Acme?' })).toBeNull()
  })

  test('Escape closes the question, not the Settings page behind it', async () => {
    show({ accounts: [makeAccount()] })
    await flush()
    click('Remove Acme')
    const behind = vi.fn()
    window.addEventListener('keydown', behind)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', behind)

    expect(screen.queryByRole('heading', { name: 'Remove Acme?' })).toBeNull()
    expect(behind).not.toHaveBeenCalled()
    expect(mocks.removeAccount).not.toHaveBeenCalled()
  })

  test('remove in use shows the account toast', async () => {
    mocks.removeAccount.mockRejectedValue(inUse)
    show({ accounts: [makeAccount()] })
    await flush()
    click('Remove Acme')

    fireEvent.click(confirm().getByRole('button', { name: 'Remove' }))
    await flush()

    expect(toasts().map((t) => ({ title: t.title, message: t.message, type: t.type }))).toEqual([
      { title: 'Account in use', message: 'Used by Alpha, Beta. Change those projects first.', type: 'error' },
    ])
    expect(screen.queryByRole('heading', { name: 'Remove Acme?' })).toBeNull()
  })

  test('any other failure is shown as it is', async () => {
    mocks.removeAccount.mockRejectedValue('database is locked')
    show({ accounts: [makeAccount()] })
    await flush()
    click('Remove Acme')

    fireEvent.click(confirm().getByRole('button', { name: 'Remove' }))
    await flush()

    expect(shown()).toEqual(['error: database is locked'])
  })

  describe('an account that is signed in', () => {
    test('suggests logging out first, which opens the logout terminal for it', async () => {
      show({ accounts: [makeAccount({ identity: signedIn })] })
      await flush()
      click('Remove Acme')
      expect(screen.getByText('Log out first to clear its saved login.')).toBeTruthy()

      fireEvent.click(confirm().getByRole('button', { name: 'Log out first' }))
      await flush()

      // The question is put aside: nothing is removed, and its Enter key must not reach the terminal.
      expect(screen.queryByRole('heading', { name: 'Remove Acme?' })).toBeNull()
      expect(mocks.removeAccount).not.toHaveBeenCalled()
      expect(mocks.startAccountTerminal).toHaveBeenCalledWith('a1', 'logout', 24, 80)
      expect(screen.getByRole('heading', { name: 'Log out of Acme' })).toBeTruthy()
    })

    test('does not suggest it when the harness cannot log out', async () => {
      show({ accounts: [makeAccount({ identity: signedIn })] }, [makeAgent('claude', 'Claude Code', { accountSupport: makeSupport({ logout: false }) })])
      await flush()

      click('Remove Acme')

      expect(screen.queryByText('Log out first to clear its saved login.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Log out first' })).toBeNull()
    })
  })

  test('does not suggest logging out for an account nobody is signed in to', async () => {
    show({ accounts: [makeAccount({ identity: makeIdentity({ status: 'signedOut' }) })] })
    await flush()

    click('Remove Acme')

    expect(screen.queryByText('Log out first to clear its saved login.')).toBeNull()
  })

  test('does not suggest logging out for an account that signs in with an API key', async () => {
    show({ accounts: [makeAccount({ identity: makeIdentity({ status: 'apiKey' }) })] })
    await flush()

    click('Remove Acme')

    expect(screen.queryByText('Log out first to clear its saved login.')).toBeNull()
  })

  test('does not suggest logging out when the CLI is not installed', async () => {
    show({ accounts: [makeAccount({ identity: signedIn })] }, [makeAgent('claude', 'Claude Code', { installed: false })])
    await flush()

    click('Remove Acme')

    expect(screen.queryByText('Log out first to clear its saved login.')).toBeNull()
  })
})
