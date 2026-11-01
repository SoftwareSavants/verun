import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@solidjs/testing-library'

// The dot that says which account a session runs on, for session tabs and the
// rows of recently closed ones. Default is the way sessions looked before
// accounts existed, so it shows nothing. An account is a dot in its color, named
// on hover. One that was removed (its sessions keep their history) or that the
// store does not know is a hollow ring instead.
import { AccountDot } from './AccountDot'
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'

/** Shows the dot of `accountId`, and returns its element. */
function show(accountId: string | null, size?: number) {
  const { container } = render(() => <AccountDot accountId={accountId} size={size} />)
  return container.firstElementChild as HTMLElement | null
}

// A fresh account for each test: the store keeps the objects it is given and
// updates them in place, so one shared across tests would carry a test's edits to the next.
beforeEach(() => applySnapshot(makeSnapshot({ accounts: [makeAccount()] })))
afterEach(() => cleanup())

describe('<AccountDot />', () => {
  test('renders nothing for Default', () => {
    const { container } = render(() => <AccountDot accountId={null} />)

    expect(container.innerHTML).toBe('')
  })

  test('uses the account color and tooltip', () => {
    const dot = show('a1')!

    expect(dot.getAttribute('title')).toBe('Acme · dev@acme.com')
    expect(dot.style.backgroundColor).toBe('rgb(124, 58, 237)')
    expect(dot.classList.contains('ring-1')).toBe(false)
  })

  test('marks removed accounts', () => {
    applySnapshot(makeSnapshot({ accounts: [makeAccount({ removedAt: 2000 })] }))

    const dot = show('a1')!

    expect(dot.getAttribute('title')).toBe('Acme (removed)')
    expect(dot.classList.contains('ring-1')).toBe(true)
    expect(dot.style.backgroundColor).toBe('')
  })

  test('names the account alone while its email is not known', () => {
    applySnapshot(makeSnapshot({ accounts: [makeAccount({ identity: makeIdentity() })] }))

    expect(show('a1')!.getAttribute('title')).toBe('Acme')
  })

  test('a removed account is a ring in its own color, so its sessions still tell it apart', () => {
    applySnapshot(makeSnapshot({ accounts: [makeAccount({ removedAt: 2000 })] }))

    const dot = show('a1')!

    expect(dot.classList.contains('ring-current')).toBe(true)
    expect(dot.style.color).toBe('rgb(124, 58, 237)')
  })

  test('marks an account the store does not know, in no color', () => {
    const dot = show('gone')!

    expect(dot.getAttribute('title')).toBe('Unknown account')
    expect(dot.classList.contains('ring-1')).toBe(true)
    expect(dot.style.backgroundColor).toBe('')
    expect(dot.style.color).toBe('')
  })

  test('is 8px like the dot of the pickers, or the size it is given', () => {
    const dot = show('a1')!
    expect(dot.style.width).toBe('8px')
    expect(dot.style.height).toBe('8px')

    cleanup()
    const small = show('a1', 6)!
    expect(small.style.width).toBe('6px')
    expect(small.style.height).toBe('6px')
  })

  test('is an image named by its tooltip, for whoever does not see the color', () => {
    show('a1')

    expect(screen.getByRole('img', { name: 'Acme · dev@acme.com' })).toBeTruthy()
  })

  // The store follows the accounts-changed event, so a dot that is open while an
  // account is edited or removed has to change with it.
  test('follows the account as it changes', () => {
    const dot = show('a1')!

    applySnapshot(makeSnapshot({ accounts: [makeAccount({ label: 'Acme Labs', color: '#16a34a' })] }))
    expect(dot.getAttribute('title')).toBe('Acme Labs · dev@acme.com')
    expect(dot.style.backgroundColor).toBe('rgb(22, 163, 74)')

    applySnapshot(makeSnapshot({ accounts: [makeAccount({ label: 'Acme Labs', color: '#16a34a', removedAt: 2000 })] }))
    expect(dot.getAttribute('title')).toBe('Acme Labs (removed)')
    expect(dot.classList.contains('ring-1')).toBe(true)
    expect(dot.style.backgroundColor).toBe('')
  })

  test('is filled once the account is known, if the sessions were listed before the accounts', () => {
    applySnapshot(makeSnapshot())
    const dot = show('a1')!
    expect(dot.getAttribute('title')).toBe('Unknown account')

    applySnapshot(makeSnapshot({ accounts: [makeAccount()] }))

    expect(dot.getAttribute('title')).toBe('Acme · dev@acme.com')
    expect(dot.style.backgroundColor).toBe('rgb(124, 58, 237)')
    expect(dot.classList.contains('ring-1')).toBe(false)
  })
})
