import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'

// The "+" menu of a task: an agent row opens the models of that agent, and a
// model starts a session. A harness with added accounts is a row for each
// account (`Claude Code · Acme`, with its color), and the session starts on the
// account of the row it was picked in.
vi.mock('../lib/ipc', () => ({ listClosedSessions: vi.fn(() => Promise.resolve([])) }))
// The harness icons are images titled with the harness; a row is named by its text.
vi.mock('./SvgIcon', () => ({ default: () => <span data-testid="agent-icon" /> }))
vi.mock('../store/agents', () => ({
  agents: [
    {
      id: 'claude', name: 'Claude Code', installed: true, cliVersion: '1.0.0',
      models: [
        { id: 'opus', label: 'Opus', description: 'Deep work' },
        { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
      ],
    },
    { id: 'codex', name: 'Codex', installed: true, models: [{ id: 'gpt', label: 'GPT', description: 'Coding' }] },
    { id: 'cursor', name: 'Cursor', installed: true, models: [] },
    { id: 'gemini', name: 'Gemini CLI', installed: false, models: [] },
  ],
}))

import { NewSessionMenu } from './NewSessionMenu'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'

const acme = makeAccount()
const beta = makeAccount({ id: 'a2', label: 'Beta', color: '#16a34a' })
const key = makeAccount({ id: 'k1', agentType: 'cursor', label: 'Key', color: '#ea580c' })

const onCreate = vi.fn()

/** Shows the menu of a task in project `p1`. */
function show(props: { projectId?: string; defaultAgent?: 'claude' | 'codex' } = {}) {
  render(() => <NewSessionMenu taskId="t1" projectId={props.projectId ?? 'p1'} defaultAgent={props.defaultAgent} onCreate={onCreate} />)
  fireEvent.click(screen.getByTitle('New Session'))
}

/** The open menu: its agent rows are its buttons, top to bottom. */
const menu = () => document.querySelector('[data-new-session-menu]') as HTMLElement
const rowNames = () => Array.from(menu().querySelectorAll('button')).map((b) => b.textContent)
const row = (name: string | RegExp) => within(menu()).getByRole('button', { name })

/** Hovers an agent row, which opens its models next to the menu. */
const hover = (name: string | RegExp) => fireEvent.mouseEnter(row(name))
const model = (name: string | RegExp) => screen.getByRole('button', { name })

beforeEach(() => {
  onCreate.mockReset()
  onCreate.mockResolvedValue(undefined)
  applySnapshot(makeSnapshot())
})
afterEach(() => cleanup())

describe('<NewSessionMenu />', () => {
  test('without accounts it is one row per installed agent, and a model starts a session with no account', () => {
    show()

    expect(rowNames()).toEqual(['Claude Code', 'Codex', 'Cursor'])
    hover('Claude Code')
    fireEvent.click(model(/Sonnet/))

    expect(onCreate).toHaveBeenCalledWith('claude', 'sonnet', undefined)
  })

  test('an agent without models starts a session when its row is clicked', () => {
    show()

    fireEvent.click(row('Cursor'))

    expect(onCreate).toHaveBeenCalledWith('cursor', undefined, undefined)
  })

  test('the default agent comes first', () => {
    show({ defaultAgent: 'codex' })

    expect(rowNames()).toEqual(['Codex', 'Claude Code', 'Cursor'])
  })

  describe('with accounts', () => {
    beforeEach(() => applySnapshot(makeSnapshot({ accounts: [acme, beta, key] })))

    test('a harness with accounts is a row for each, Default first for a project that uses none', () => {
      show()

      expect(rowNames()).toEqual(['Claude Code · Default', 'Claude Code · Acme', 'Claude Code · Beta', 'Codex', 'Cursor · Default', 'Cursor · Key'])
    })

    test('the account the project uses leads its harness', () => {
      applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a2' }] }))
      show()

      expect(rowNames()).toEqual(['Claude Code · Beta', 'Claude Code · Default', 'Claude Code · Acme', 'Codex', 'Cursor'])
    })

    test('another project has its own', () => {
      applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a2' }] }))
      show({ projectId: 'p2' })

      expect(rowNames()).toEqual(['Claude Code · Default', 'Claude Code · Acme', 'Claude Code · Beta', 'Codex', 'Cursor'])
    })

    test('a model picked under an account starts a session on it', () => {
      show()

      hover('Claude Code · Acme')
      fireEvent.click(model(/Opus/))

      expect(onCreate).toHaveBeenCalledWith('claude', 'opus', { kind: 'account', id: 'a1' })
    })

    test('a model picked under Default starts a session on Default', () => {
      show()

      hover('Claude Code · Default')
      fireEvent.click(model(/Sonnet/))

      expect(onCreate).toHaveBeenCalledWith('claude', 'sonnet', { kind: 'default' })
    })

    test('the models follow the row that is hovered', () => {
      show()

      hover('Claude Code · Beta')
      expect(screen.getByRole('button', { name: /Opus/ })).toBeTruthy()
      hover('Codex')

      expect(screen.queryByRole('button', { name: /Opus/ })).toBeNull()
      fireEvent.click(model(/GPT/))
      expect(onCreate).toHaveBeenCalledWith('codex', 'gpt', undefined)
    })

    test('an agent without models starts its session on the account of the row clicked', () => {
      show()

      fireEvent.click(row('Cursor · Key'))

      expect(onCreate).toHaveBeenCalledWith('cursor', undefined, { kind: 'account', id: 'k1' })
    })

    test('an account has its color, Default does not', () => {
      show()

      expect(within(row('Claude Code · Default')).queryByTestId('account-color')).toBeNull()
      expect(within(row('Claude Code · Acme')).getByTestId('account-color').style.backgroundColor).toBe('rgb(124, 58, 237)')
      expect(within(row('Codex')).queryByTestId('account-color')).toBeNull()
    })

    test('a row with an account has its full name as a tooltip, since a long label is cut short', () => {
      show()

      expect(row('Claude Code · Acme').getAttribute('title')).toBe('Claude Code · Acme')
      expect(row('Codex').hasAttribute('title')).toBe(false)
    })

    test('the Default row says who the harness is signed in as', () => {
      applySnapshot(makeSnapshot({
        accounts: [acme],
        defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'signedIn', email: 'me@home.dev' }) }],
      }))
      show()

      expect(row(/^Claude Code · Default/).textContent).toContain('me@home.dev')
      expect(row('Claude Code · Acme').textContent).not.toContain('me@home.dev')
    })

    test('closes the menu once a session is being started', () => {
      show()

      hover('Claude Code · Acme')
      fireEvent.click(model(/Opus/))

      expect(document.querySelector('[data-new-session-menu]')).toBeNull()
    })
  })
})
