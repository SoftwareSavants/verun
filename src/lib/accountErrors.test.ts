import { describe, test, expect, vi, beforeEach } from 'vitest'

const ui = vi.hoisted(() => ({ addToast: vi.fn(), openSettings: vi.fn() }))
vi.mock('../store/ui', () => ui)

import { parseAccountError, accountErrorMessage, notifyAccountError, type AccountErrorPayload } from './accountErrors'

/** What `AccountError::to_ipc` sends: `ACCOUNT_ERROR:` and then the JSON. */
const ipcError = (fields: Pick<AccountErrorPayload, 'kind'> & Partial<AccountErrorPayload>) =>
  `ACCOUNT_ERROR:${JSON.stringify({ accountId: null, label: null, projects: [], message: null, ...fields })}`

/** The toast `addToast` was last asked for. */
function lastToast() {
  const calls = ui.addToast.mock.calls
  const [message, type, options] = calls[calls.length - 1]
  return { message: message as string, type: type as string, options: options as { title: string; actions?: { label: string; variant?: string; onClick: () => void }[] } }
}

beforeEach(() => {
  ui.addToast.mockReset()
  ui.openSettings.mockReset()
})

describe('parseAccountError', () => {
  test('parseAccountError reads prefixed JSON and ignores other errors', () => {
    expect(parseAccountError(ipcError({ kind: 'signedOut', accountId: 'a1', label: 'Acme' }))).toEqual({
      kind: 'signedOut',
      accountId: 'a1',
      label: 'Acme',
      projects: [],
      message: null,
    })
    // An Error carries the same string in its message.
    expect(parseAccountError(new Error(ipcError({ kind: 'removed', accountId: 'a1', label: 'Acme' })))?.kind).toBe('removed')

    const notAccountErrors: unknown[] = [
      'boom',
      new Error('boom'),
      'ACCOUNT_ERROR:',
      'ACCOUNT_ERROR:not json',
      'ACCOUNT_ERROR:[]',
      'ACCOUNT_ERROR:null',
      'ACCOUNT_ERROR:{"label":"Acme"}',
      // The prefix starts the string; one buried in other text is not ours.
      'Task created, but the agent could not start: ACCOUNT_ERROR:{"kind":"busy"}',
      undefined,
      null,
      42,
      {},
    ]
    for (const error of notAccountErrors) expect(parseAccountError(error), String(error)).toBeNull()
  })

  // The payloads of `every_account_error_carries_its_own_fields` in
  // src-tauri/src/accounts/mod.rs, written the way serde writes them. A field
  // renamed on either side fails a test on that side.
  test('reads what the backend sends for every kind', () => {
    const sent: [string, AccountErrorPayload][] = [
      [
        '{"kind":"removed","accountId":"a1","label":"Acme","projects":[],"message":null}',
        { kind: 'removed', accountId: 'a1', label: 'Acme', projects: [], message: null },
      ],
      [
        '{"kind":"signedOut","accountId":"a1","label":"Acme","projects":[],"message":null}',
        { kind: 'signedOut', accountId: 'a1', label: 'Acme', projects: [], message: null },
      ],
      [
        '{"kind":"missing","accountId":"a1","label":null,"projects":[],"message":null}',
        { kind: 'missing', accountId: 'a1', label: null, projects: [], message: null },
      ],
      [
        '{"kind":"wrongHarness","accountId":"a1","label":null,"projects":[],"message":null}',
        { kind: 'wrongHarness', accountId: 'a1', label: null, projects: [], message: null },
      ],
      [
        '{"kind":"secret","accountId":"a1","label":"Acme","projects":[],"message":"ANTHROPIC_API_KEY has no stored value"}',
        { kind: 'secret', accountId: 'a1', label: 'Acme', projects: [], message: 'ANTHROPIC_API_KEY has no stored value' },
      ],
      [
        '{"kind":"busy","accountId":null,"label":null,"projects":[],"message":null}',
        { kind: 'busy', accountId: null, label: null, projects: [], message: null },
      ],
      [
        '{"kind":"inUse","accountId":"a1","label":null,"projects":["Web","API"],"message":null}',
        { kind: 'inUse', accountId: 'a1', label: null, projects: ['Web', 'API'], message: null },
      ],
      [
        '{"kind":"invalid","accountId":null,"label":null,"projects":[],"message":"Choose a folder path."}',
        { kind: 'invalid', accountId: null, label: null, projects: [], message: 'Choose a folder path.' },
      ],
    ]
    for (const [json, payload] of sent) expect(parseAccountError(`ACCOUNT_ERROR:${json}`)).toEqual(payload)
  })

  test('fills in what a payload leaves out', () => {
    expect(parseAccountError('ACCOUNT_ERROR:{"kind":"busy"}')).toEqual({
      kind: 'busy',
      accountId: null,
      label: null,
      projects: [],
      message: null,
    })
  })
})

describe('notifyAccountError', () => {
  test('signedOut toast offers Log in', () => {
    expect(notifyAccountError(ipcError({ kind: 'signedOut', accountId: 'a1', label: 'Acme' }))).toBe(true)

    const { message, type, options } = lastToast()
    expect(type).toBe('error')
    expect(options.title).toBe('Account signed out')
    expect(message).toBe('Acme is signed out.')
    expect(options.actions).toHaveLength(1)
    expect(options.actions![0].label).toBe('Log in')
    expect(options.actions![0].variant).toBe('primary')

    // The button takes the user to the account to log in to.
    expect(ui.openSettings).not.toHaveBeenCalled()
    options.actions![0].onClick()
    expect(ui.openSettings).toHaveBeenCalledWith('accounts')
  })

  test('removed toast offers Choose account', () => {
    expect(notifyAccountError(ipcError({ kind: 'removed', accountId: 'a1', label: 'Acme' }))).toBe(true)

    const { message, options } = lastToast()
    expect(options.title).toBe('Account removed')
    expect(message).toBe('Acme was removed. Start a new session on another account.')
    expect(options.actions).toHaveLength(1)
    expect(options.actions![0].label).toBe('Choose account')
    options.actions![0].onClick()
    expect(ui.openSettings).toHaveBeenCalledWith('accounts')
  })

  test('inUse toast names the projects and has no action', () => {
    expect(notifyAccountError(ipcError({ kind: 'inUse', accountId: 'a1', projects: ['Web', 'API'] }))).toBe(true)

    const { message, options } = lastToast()
    expect(options.title).toBe('Account in use')
    expect(message).toBe('Used by Web, API. Change those projects first.')
    expect(options.actions).toBeUndefined()
  })

  test('busy toast asks to finish the other login and has no action', () => {
    expect(notifyAccountError(ipcError({ kind: 'busy' }))).toBe(true)

    const { message, options } = lastToast()
    expect(options.title).toBe('Login already open')
    expect(message).toBe('Finish or close the other login first.')
    expect(options.actions).toBeUndefined()
  })

  test('secret toast blames the keychain and has no action', () => {
    expect(notifyAccountError(ipcError({ kind: 'secret', accountId: 'a1', label: 'Acme', message: 'ANTHROPIC_API_KEY has no stored value' }))).toBe(true)

    const { message, options } = lastToast()
    expect(options.title).toBe('Keychain error')
    expect(message).toBe("Couldn't read a secret for Acme from the keychain.")
    expect(options.actions).toBeUndefined()
  })

  test('every other kind shows its message under Account error', () => {
    expect(notifyAccountError(ipcError({ kind: 'invalid', message: 'Choose a folder path.' }))).toBe(true)

    const { message, options } = lastToast()
    expect(options.title).toBe('Account error')
    expect(message).toBe('Choose a folder path.')
    expect(options.actions).toBeUndefined()
  })

  test('kinds that carry no message still say something', () => {
    for (const kind of ['missing', 'wrongHarness'] as const) {
      ui.addToast.mockClear()
      expect(notifyAccountError(ipcError({ kind, accountId: 'a1' })), kind).toBe(true)
      const { message, options } = lastToast()
      expect(options.title, kind).toBe('Account error')
      expect(message, kind).toBe('Something is wrong with this account.')
    }
  })

  test('a kind this build does not know is an Account error too', () => {
    expect(notifyAccountError('ACCOUNT_ERROR:{"kind":"expired","message":"Renew the plan."}')).toBe(true)

    const { message, options } = lastToast()
    expect(options.title).toBe('Account error')
    expect(message).toBe('Renew the plan.')
  })

  test('an account the error does not name is still described', () => {
    notifyAccountError(ipcError({ kind: 'signedOut' }))
    expect(lastToast().message).toBe('This account is signed out.')

    notifyAccountError(ipcError({ kind: 'removed' }))
    expect(lastToast().message).toBe('This account was removed. Start a new session on another account.')

    notifyAccountError(ipcError({ kind: 'secret' }))
    expect(lastToast().message).toBe("Couldn't read a secret for an account from the keychain.")
  })

  test('other errors are left alone', () => {
    for (const error of ['boom', new Error('boom'), undefined]) {
      expect(notifyAccountError(error), String(error)).toBe(false)
    }
    expect(ui.addToast).not.toHaveBeenCalled()
  })

  // For places that keep the problem on screen once the toast is gone.
  test('accountErrorMessage is the sentence the toast shows', () => {
    const cases: [string, string][] = [
      [ipcError({ kind: 'signedOut', label: 'Acme' }), 'Acme is signed out.'],
      [ipcError({ kind: 'removed', label: 'Acme' }), 'Acme was removed. Start a new session on another account.'],
      [ipcError({ kind: 'inUse', projects: ['Web', 'API'] }), 'Used by Web, API. Change those projects first.'],
      [ipcError({ kind: 'invalid', message: 'Choose a folder path.' }), 'Choose a folder path.'],
    ]
    for (const [error, sentence] of cases) {
      ui.addToast.mockClear()
      notifyAccountError(error)
      expect(accountErrorMessage(error)).toBe(sentence)
      expect(lastToast().message).toBe(sentence)
    }
    expect(accountErrorMessage('boom')).toBeNull()
    expect(accountErrorMessage(new Error('boom'))).toBeNull()
  })

  test('accountErrorMessage shows nothing by itself', () => {
    accountErrorMessage(ipcError({ kind: 'signedOut', label: 'Acme' }))
    expect(ui.addToast).not.toHaveBeenCalled()
  })

  test('toast copy uses plain hyphens, never dashes', () => {
    const errors = [
      ipcError({ kind: 'signedOut', label: 'Acme' }),
      ipcError({ kind: 'removed', label: 'Acme' }),
      ipcError({ kind: 'inUse', projects: ['Web'] }),
      ipcError({ kind: 'busy' }),
      ipcError({ kind: 'secret', label: 'Acme' }),
      ipcError({ kind: 'missing' }),
    ]
    for (const error of errors) {
      ui.addToast.mockClear()
      notifyAccountError(error)
      const { message, options } = lastToast()
      const copy = [message, options.title, ...(options.actions ?? []).map(a => a.label)]
      for (const text of copy) expect(text).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
