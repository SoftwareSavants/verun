import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'

// Project settings -> Accounts: for each harness that has an account, which one
// new sessions in the project use. A choice goes to the backend; the select
// follows the accounts store, which only the accounts-changed event updates
// (never the snapshot the command resolves with).
const mocks = vi.hoisted(() => ({ setProjectAccount: vi.fn() }))
vi.mock('../lib/ipc', () => ({ setProjectAccount: mocks.setProjectAccount }))

import { ProjectAccountsSettings } from './ProjectAccountsSettings'
import { applySnapshot, projectAccountId } from '../store/accounts'
import { toasts, setToasts } from '../store/ui'
import type { Account, AccountIdentity, AccountsSnapshot, ProjectAccount } from '../types'

const removed = 'ACCOUNT_ERROR:{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}'

const makeIdentity = (overrides: Partial<AccountIdentity> = {}): AccountIdentity => ({
  status: 'signedOut',
  email: null,
  orgName: null,
  plan: null,
  providers: [],
  ...overrides,
})

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
  identity: makeIdentity({ status: 'signedIn', email: 'dev@acme.com' }),
  ...overrides,
})

const acme = makeAccount()
const beta = makeAccount({ id: 'a2', label: 'Beta' })
const work = makeAccount({ id: 'c1', agentType: 'codex', label: 'Work' })

const claudeDefault = { agentType: 'claude' as const, identity: makeIdentity({ status: 'signedIn', email: 'me@home.dev' }) }

const binding = (projectId: string, agentType: ProjectAccount['agentType'], accountId: string): ProjectAccount => ({ projectId, agentType, accountId })

/** What the toasts say, as `type: message`. */
const shown = () => toasts().map((t) => `${t.type}: ${t.message}`)

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const snapshotOf = (snapshot: Partial<AccountsSnapshot>): AccountsSnapshot => ({ accounts: [], defaults: [], projectAccounts: [], ...snapshot })

/** Puts the accounts in the store and shows the settings of project `p1`. */
function show(snapshot: Partial<AccountsSnapshot> = {}) {
  applySnapshot(snapshotOf(snapshot))
  return render(() => <ProjectAccountsSettings projectId="p1" />)
}

const select = (harness: string) => screen.getByRole('combobox', { name: harness })

/** What a select shows as chosen. */
const chosen = (harness: string) => select(harness).textContent

/** Opens the select of a harness and picks an option, as a click would. */
function choose(harness: string, option: string) {
  fireEvent.click(select(harness))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

/** The options of a harness's select, as they are listed. */
function optionsOf(harness: string): (string | null)[] {
  fireEvent.click(select(harness))
  return screen.getAllByRole('option').map((o) => o.textContent)
}

beforeEach(() => {
  mocks.setProjectAccount.mockReset()
  mocks.setProjectAccount.mockResolvedValue(snapshotOf({}))
  applySnapshot(snapshotOf({}))
  setToasts([])
})

afterEach(() => cleanup())

describe('ProjectAccountsSettings', () => {
  test('renders a select only for harnesses with accounts', () => {
    show({
      accounts: [
        acme,
        work,
        // Nothing to choose from: the only account of Gemini is gone.
        makeAccount({ id: 'g1', agentType: 'gemini', label: 'Old', removedAt: 5 }),
      ],
    })

    expect(screen.getAllByRole('combobox').map((s) => s.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex'])
    expect(screen.queryByRole('combobox', { name: 'Gemini CLI' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Cursor' })).toBeNull()
  })

  test('choosing an account binds it', async () => {
    show({ accounts: [acme, beta], defaults: [claudeDefault] })

    choose('Claude Code', 'Acme')
    await flush()

    expect(mocks.setProjectAccount).toHaveBeenCalledOnce()
    expect(mocks.setProjectAccount).toHaveBeenCalledWith('p1', 'claude', 'a1')
  })

  test('choosing Default clears the binding', async () => {
    show({ accounts: [acme], defaults: [claudeDefault], projectAccounts: [binding('p1', 'claude', 'a1')] })

    choose('Claude Code', 'Default · me@home.dev')
    await flush()

    expect(mocks.setProjectAccount).toHaveBeenCalledOnce()
    expect(mocks.setProjectAccount).toHaveBeenCalledWith('p1', 'claude', null)
  })

  test('each harness binds its own account', async () => {
    show({ accounts: [acme, work] })

    choose('Codex', 'Work')
    await flush()

    expect(mocks.setProjectAccount).toHaveBeenCalledWith('p1', 'codex', 'c1')
  })

  test('has the heading and says what it is for', () => {
    show({ accounts: [acme] })

    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy()
    expect(screen.getByText('New sessions in this project use these accounts. Existing sessions keep theirs.')).toBeTruthy()
  })

  test('shows nothing at all while no harness has an account', () => {
    const view = show({ accounts: [makeAccount({ removedAt: 5 })] })

    expect(view.container.innerHTML).toBe('')
  })

  describe('the options', () => {
    test('are Default, with who the harness is signed in as, then each account', () => {
      show({ accounts: [acme, beta], defaults: [claudeDefault] })

      expect(optionsOf('Claude Code')).toEqual(['Default · me@home.dev', 'Acme', 'Beta'])
    })

    test('are Default alone when nobody is known to be signed in', () => {
      show({
        accounts: [acme],
        defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'signedOut' }) }],
      })

      expect(optionsOf('Claude Code')).toEqual(['Default', 'Acme'])
    })

    test('are Default alone for a harness the snapshot has no Default for', () => {
      show({ accounts: [work], defaults: [claudeDefault] })

      expect(optionsOf('Codex')).toEqual(['Default', 'Work'])
    })

    test('leave out removed accounts and the accounts of other harnesses', () => {
      show({ accounts: [acme, makeAccount({ id: 'a3', label: 'Old', removedAt: 5 }), work] })

      expect(optionsOf('Claude Code')).toEqual(['Default', 'Acme'])
    })
  })

  describe('what is chosen', () => {
    test('is Default while the project has no binding', () => {
      show({ accounts: [acme], defaults: [claudeDefault] })

      expect(chosen('Claude Code')).toContain('Default · me@home.dev')
    })

    test('is the account the project is bound to', () => {
      show({ accounts: [acme, beta], projectAccounts: [binding('p1', 'claude', 'a2')] })

      expect(chosen('Claude Code')).toContain('Beta')
    })

    test('ignores the bindings of other projects and of other harnesses', () => {
      show({
        accounts: [acme, work],
        projectAccounts: [binding('p2', 'claude', 'a1'), binding('p1', 'codex', 'c1')],
      })

      expect(chosen('Claude Code')).toContain('Default')
      expect(chosen('Codex')).toContain('Work')
    })

    test('follows the project it is given', () => {
      applySnapshot(snapshotOf({ accounts: [acme, beta], projectAccounts: [binding('p1', 'claude', 'a1'), binding('p2', 'claude', 'a2')] }))
      const [projectId, setProjectId] = createSignal('p1')
      render(() => <ProjectAccountsSettings projectId={projectId()} />)
      expect(chosen('Claude Code')).toContain('Acme')

      setProjectId('p2')

      expect(chosen('Claude Code')).toContain('Beta')
    })

    test('follows the store: what the accounts-changed event brings shows without a reload', () => {
      show({ accounts: [acme] })
      expect(screen.queryByRole('combobox', { name: 'Codex' })).toBeNull()
      expect(chosen('Claude Code')).toContain('Default')

      // What the event does when an account is added and bound elsewhere.
      applySnapshot(snapshotOf({ accounts: [acme, work], projectAccounts: [binding('p1', 'claude', 'a1')] }))

      expect(chosen('Claude Code')).toContain('Acme')
      expect(chosen('Codex')).toContain('Default')
      expect(optionsOf('Codex')).toEqual(['Default', 'Work'])
    })
  })

  describe('after a choice', () => {
    test('says so once the backend has saved it, and the select waits for the event', async () => {
      const bound = snapshotOf({ accounts: [acme], projectAccounts: [binding('p1', 'claude', 'a1')] })
      mocks.setProjectAccount.mockResolvedValue(bound)
      show({ accounts: [acme] })

      choose('Claude Code', 'Acme')
      expect(shown()).toEqual([])
      await flush()

      expect(shown()).toEqual(['success: Claude Code account set to Acme'])
      // The snapshot the command resolved with is not applied: the event brings it.
      expect(projectAccountId('p1', 'claude')).toBeNull()
      expect(chosen('Claude Code')).toContain('Default')

      applySnapshot(bound)

      expect(chosen('Claude Code')).toContain('Acme')
    })

    test('names Default when the binding is cleared', async () => {
      show({ accounts: [acme], projectAccounts: [binding('p1', 'claude', 'a1')] })

      choose('Claude Code', 'Default')
      await flush()

      expect(shown()).toEqual(['success: Claude Code account set to Default'])
    })

    test('choosing what is already chosen changes nothing', async () => {
      show({ accounts: [acme], projectAccounts: [binding('p1', 'claude', 'a1')] })

      choose('Claude Code', 'Acme')
      await flush()

      expect(mocks.setProjectAccount).not.toHaveBeenCalled()
      expect(shown()).toEqual([])
    })

    test('an account problem shows its account toast and no success', async () => {
      mocks.setProjectAccount.mockRejectedValue(removed)
      show({ accounts: [acme] })

      choose('Claude Code', 'Acme')
      await flush()

      expect(shown()).toEqual(['error: Acme was removed. Start a new session on another account.'])
      expect(toasts()[0].title).toBe('Account removed')
      expect(chosen('Claude Code')).toContain('Default')
    })

    test('any other failure is shown as it is', async () => {
      mocks.setProjectAccount.mockRejectedValue('database is locked')
      show({ accounts: [acme] })

      choose('Claude Code', 'Acme')
      await flush()

      expect(shown()).toEqual(['error: database is locked'])
    })
  })
})
