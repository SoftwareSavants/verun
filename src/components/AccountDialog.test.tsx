import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { reconcile } from 'solid-js/store'

// The dialog adds an account or edits one. The command's own snapshot is never
// applied to the store: every window gets it as the `accounts-changed` event.
const mocks = vi.hoisted(() => ({ createAccount: vi.fn(), updateAccount: vi.fn() }))
vi.mock('../lib/ipc', () => mocks)
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))

import { AccountDialog } from './AccountDialog'
import { setAgents } from '../store/agents'
import { accountsState, applySnapshot } from '../store/accounts'
import { toasts, setToasts } from '../store/ui'
import type { Account, AccountSupport, AgentInfo, AgentType } from '../types'

const STORED = 'Stored - leave empty to keep'
const invalid = 'ACCOUNT_ERROR:{"kind":"invalid","accountId":null,"label":null,"projects":[],"message":"Give the account a name."}'

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

const makeAgent = (id: AgentType, name: string, support: Partial<AccountSupport> | null = {}): AgentInfo => ({
  id,
  name,
  installHint: '',
  updateHint: '',
  docsUrl: '',
  models: [],
  installed: true,
  supportsStreaming: true,
  supportsResume: true,
  supportsPlanMode: true,
  supportsModelSelection: true,
  supportsEffort: true,
  supportsSkills: true,
  supportsAttachments: true,
  supportsFork: true,
  accountSupport: support === null ? null : makeSupport(support),
})

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
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
  ...overrides,
})

/** What the toasts say, as `type: message`. */
const shown = () => toasts().map((t) => `${t.type}: ${t.message}`)

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const input = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } })
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const addVariable = (key: string, value: string) => {
  click('Add variable')
  const keys = screen.getAllByLabelText('Variable name')
  const values = screen.getAllByLabelText('Value')
  input(keys[keys.length - 1], key)
  input(values[values.length - 1], value)
}

function add(agentType: AgentType = 'claude', onClose: () => void = () => {}) {
  return render(() => <AccountDialog open agentType={agentType} onClose={onClose} />)
}

function edit(account: Account, onClose: () => void = () => {}) {
  return render(() => <AccountDialog open agentType={account.agentType} account={account} onClose={onClose} />)
}

beforeEach(() => {
  setAgents(reconcile([makeAgent('claude', 'Claude Code')]))
  applySnapshot({ accounts: [], defaults: [], projectAccounts: [] })
  mocks.createAccount.mockReset()
  mocks.updateAccount.mockReset()
  mocks.createAccount.mockResolvedValue({ accounts: [], defaults: [], projectAccounts: [] })
  mocks.updateAccount.mockResolvedValue({ accounts: [], defaults: [], projectAccounts: [] })
  setToasts([])
})

afterEach(() => cleanup())

describe('AccountDialog adding an account', () => {
  test('create sends a managed account', async () => {
    const onClose = vi.fn()
    add('claude', onClose)

    input(field('Label'), 'Acme')
    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith({
      agentType: 'claude',
      label: 'Acme',
      color: '#7c3aed',
      existingDir: null,
      env: [],
    })
    expect(mocks.updateAccount).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
    expect(shown()).toEqual(['success: Added Acme'])
  })

  test('names the harness in the title', () => {
    setAgents(reconcile([makeAgent('codex', 'Codex')]))
    add('codex')

    expect(screen.getByRole('heading').textContent).toBe('Add Codex account')
  })

  test('does not apply the snapshot the command returns', async () => {
    mocks.createAccount.mockResolvedValue({ accounts: [makeAccount()], defaults: [], projectAccounts: [] })
    add()

    input(field('Label'), 'Acme')
    click('Add account')
    await flush()

    // The accounts-changed event brings it, once, from the backend.
    expect(accountsState.accounts).toEqual([])
  })

  test('the label is trimmed and needed', async () => {
    add()
    const submit = screen.getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    input(field('Label'), '   ')
    expect(submit.disabled).toBe(true)

    input(field('Label'), '  Acme  ')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({ label: 'Acme' }))
  })

  test('Enter in the label field adds the account', async () => {
    add()
    input(field('Label'), 'Acme')

    fireEvent.keyDown(field('Label'), { key: 'Enter' })
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledOnce()
  })

  test('adding twice is not possible while the first is still being saved', async () => {
    mocks.createAccount.mockReturnValue(new Promise(() => {}))
    add()
    input(field('Label'), 'Acme')

    fireEvent.keyDown(field('Label'), { key: 'Enter' })
    fireEvent.keyDown(field('Label'), { key: 'Enter' })
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledOnce()
    const submit = screen.getByRole('button', { name: 'Saving...' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  test('the Enter that confirms an IME composition does not add the account', async () => {
    add()
    input(field('Label'), 'Acme')

    fireEvent.keyDown(field('Label'), { key: 'Enter', isComposing: true })
    await flush()

    expect(mocks.createAccount).not.toHaveBeenCalled()
  })

  test('Enter does nothing while the label is empty', async () => {
    add()

    fireEvent.keyDown(field('Label'), { key: 'Enter' })
    await flush()

    expect(mocks.createAccount).not.toHaveBeenCalled()
  })

  test('the color picked in the swatch is sent', async () => {
    add()
    input(field('Label'), 'Acme')

    click('Pick a color')
    input(screen.getByDisplayValue('#7c3aed'), '#112233')
    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({ color: '#112233' }))
  })

  describe('the color picker', () => {
    /** Where the picker is, as the screen sees it (it is placed by the screen, not by the dialog). */
    const pickerAt = () => {
      const picker = screen.getByDisplayValue('#7c3aed').closest('div[style*="left"]') as HTMLElement
      return { left: picker.style.left, top: picker.style.top }
    }
    const swatchAt = (left: number, bottom: number) => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left, bottom, top: bottom - 36, right: left + 36, width: 36, height: 36, x: left, y: bottom - 36, toJSON: () => ({}) })

    afterEach(() => {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })

    test('opens just below its swatch', () => {
      swatchAt(100, 200)
      add()

      click('Pick a color')

      expect(pickerAt()).toEqual({ left: '100px', top: '208px' })
    })

    test('is kept on screen when the swatch is low', () => {
      vi.stubGlobal('innerHeight', 600)
      swatchAt(100, 590)
      add()

      click('Pick a color')

      // Its height above the bottom of the window, not below the swatch.
      expect(pickerAt()).toEqual({ left: '100px', top: '360px' })
    })

    test('is kept on screen when the window is very small', () => {
      vi.stubGlobal('innerHeight', 200)
      swatchAt(100, 150)
      add()

      click('Pick a color')

      expect(pickerAt()).toEqual({ left: '100px', top: '8px' })
    })

    test('closes with a second click on the swatch', () => {
      add()
      click('Pick a color')
      expect(screen.queryByDisplayValue('#7c3aed')).not.toBeNull()

      click('Pick a color')

      expect(screen.queryByDisplayValue('#7c3aed')).toBeNull()
    })
  })

  test('Cancel closes without adding anything', () => {
    const onClose = vi.fn()
    add('claude', onClose)
    input(field('Label'), 'Acme')

    click('Cancel')

    expect(onClose).toHaveBeenCalledOnce()
    expect(mocks.createAccount).not.toHaveBeenCalled()
  })

  test('Escape closes the dialog, not the Settings page behind it', () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    const onClose = vi.fn()
    add('claude', onClose)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', behind)

    expect(onClose).toHaveBeenCalledOnce()
    expect(behind).not.toHaveBeenCalled()
  })

  test('a closed dialog shows nothing, and opens on a clean form again', () => {
    const [open, setOpen] = createSignal(true)
    render(() => <AccountDialog open={open()} agentType="claude" onClose={() => setOpen(false)} />)
    input(field('Label'), 'Acme')
    addVariable('KEY', 'value')

    setOpen(false)
    expect(screen.queryByLabelText('Label')).toBeNull()
    setOpen(true)

    expect(field('Label').value).toBe('')
    expect(screen.queryByLabelText('Variable name')).toBeNull()
  })

  describe('errors', () => {
    test('an account error is shown as its toast and the dialog stays open', async () => {
      mocks.createAccount.mockRejectedValue(invalid)
      const onClose = vi.fn()
      add('claude', onClose)
      input(field('Label'), 'Acme')

      click('Add account')
      await flush()

      expect(toasts().map((t) => ({ title: t.title, message: t.message }))).toEqual([
        { title: 'Account error', message: 'Give the account a name.' },
      ])
      expect(onClose).not.toHaveBeenCalled()
      // The user can fix it and try again.
      expect((screen.getByRole('button', { name: 'Add account' }) as HTMLButtonElement).disabled).toBe(false)
    })

    test('any other error is shown as it is', async () => {
      mocks.createAccount.mockRejectedValue('database is locked')
      const onClose = vi.fn()
      add('claude', onClose)
      input(field('Label'), 'Acme')

      click('Add account')
      await flush()

      expect(shown()).toEqual(['error: database is locked'])
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})

describe('AccountDialog folder', () => {
  test('existing folder option only when supported', () => {
    add()
    expect(screen.getByRole('combobox', { name: 'Folder' })).toBeTruthy()
    cleanup()

    setAgents(reconcile([makeAgent('cursor', 'Cursor', { existingDir: false })]))
    add('cursor')
    expect(screen.queryByRole('combobox', { name: 'Folder' })).toBeNull()
  })

  test('a new folder is the default, and shows no path field', () => {
    add()

    expect(screen.getByRole('combobox', { name: 'Folder' }).textContent).toContain('New folder managed by Verun')
    expect(screen.queryByLabelText('Folder path')).toBeNull()
  })

  test('an existing folder needs its path and sends it', async () => {
    add()
    input(field('Label'), 'Acme')

    fireEvent.click(screen.getByRole('combobox', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: 'Existing folder' }))
    const submit = screen.getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    input(field('Folder path'), '  ~/.claude-acme  ')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({ existingDir: '~/.claude-acme' }))
  })

  test('going back to a new folder sends no path', async () => {
    add()
    input(field('Label'), 'Acme')
    fireEvent.click(screen.getByRole('combobox', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: 'Existing folder' }))
    input(field('Folder path'), '/somewhere')

    fireEvent.click(screen.getByRole('combobox', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: 'New folder managed by Verun' }))
    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({ existingDir: null }))
  })

  test('an account that exists keeps its folder: editing offers no choice', () => {
    edit(makeAccount())

    expect(screen.queryByRole('combobox', { name: 'Folder' })).toBeNull()
  })
})

describe('AccountDialog environment variables', () => {
  test('rows are sent with their key and value, plain by default', async () => {
    add()
    input(field('Label'), 'Acme')
    addVariable('ANTHROPIC_BASE_URL', 'https://proxy.test')
    addVariable('MODE', 'fast')

    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [
        { key: 'ANTHROPIC_BASE_URL', value: 'https://proxy.test', secret: false },
        { key: 'MODE', value: 'fast', secret: false },
      ],
    }))
  })

  test('secret env rows are sent with secret true', async () => {
    add()
    input(field('Label'), 'Acme')
    addVariable('MY_TOKEN', 's3cret')
    const value = screen.getByLabelText('Value') as HTMLInputElement
    expect(value.type).toBe('text')

    fireEvent.click(screen.getByLabelText('Secret'))
    // A secret is typed hidden.
    expect(value.type).toBe('password')
    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [{ key: 'MY_TOKEN', value: 's3cret', secret: true }],
    }))
  })

  test('typing in a row keeps focus on it', () => {
    add()
    click('Add variable')
    const key = screen.getByLabelText('Variable name') as HTMLInputElement
    key.focus()

    input(key, 'A')
    input(key, 'AB')

    // The row is edited in place, not replaced.
    expect(screen.getByLabelText('Variable name')).toBe(key)
    expect(document.activeElement).toBe(key)
  })

  test('a row can be taken out again, whichever it is', async () => {
    add()
    input(field('Label'), 'Acme')
    addVariable('ONE', '1')
    addVariable('TWO', '2')
    addVariable('THREE', '3')

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove variable' })[1])
    expect((screen.getAllByLabelText('Variable name') as HTMLInputElement[]).map((el) => el.value)).toEqual(['ONE', 'THREE'])
    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [
        { key: 'ONE', value: '1', secret: false },
        { key: 'THREE', value: '3', secret: false },
      ],
    }))
  })

  test('a row left empty is not sent', async () => {
    add()
    input(field('Label'), 'Acme')
    click('Add variable')
    click('Add variable')
    addVariable('KEPT', 'yes')

    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [{ key: 'KEPT', value: 'yes', secret: false }],
    }))
  })

  test('keys are trimmed, values are sent as typed', async () => {
    add()
    input(field('Label'), 'Acme')
    addVariable('  SPACED  ', ' a b ')

    click('Add account')
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [{ key: 'SPACED', value: ' a b ', secret: false }],
    }))
  })
})

describe('AccountDialog required secret', () => {
  beforeEach(() => {
    setAgents(reconcile([makeAgent('cursor', 'Cursor', { existingDir: false, requiredSecret: 'CURSOR_API_KEY' })]))
  })

  test('is a password field labeled with the key', () => {
    add('cursor')

    expect(field('CURSOR_API_KEY').type).toBe('password')
  })

  test('is needed to add the account, and is sent as a secret', async () => {
    add('cursor')
    input(field('Label'), 'Work')
    const submit = screen.getByRole('button', { name: 'Add account' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    input(field('CURSOR_API_KEY'), 'key-1')
    addVariable('MODE', 'fast')
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await flush()

    expect(mocks.createAccount).toHaveBeenCalledWith({
      agentType: 'cursor',
      label: 'Work',
      color: '#7c3aed',
      existingDir: null,
      env: [
        { key: 'CURSOR_API_KEY', value: 'key-1', secret: true },
        { key: 'MODE', value: 'fast', secret: false },
      ],
    })
  })

  test('editing keeps the stored key when the field is left empty, and does not list it as a variable', async () => {
    edit(makeAccount({ agentType: 'cursor', env: [{ key: 'CURSOR_API_KEY', value: null, secret: true }] }))

    expect(field('CURSOR_API_KEY').placeholder).toBe(STORED)
    expect(screen.queryByLabelText('Variable name')).toBeNull()
    click('Save')
    await flush()

    expect(mocks.updateAccount).toHaveBeenCalledWith({
      id: 'a1',
      label: 'Acme',
      color: '#7c3aed',
      env: [{ key: 'CURSOR_API_KEY', value: null, secret: true }],
    })
  })

  test('editing replaces the key when a new one is typed', async () => {
    edit(makeAccount({ agentType: 'cursor', env: [{ key: 'CURSOR_API_KEY', value: null, secret: true }] }))

    input(field('CURSOR_API_KEY'), 'key-2')
    click('Save')
    await flush()

    expect(mocks.updateAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [{ key: 'CURSOR_API_KEY', value: 'key-2', secret: true }],
    }))
  })
})

describe('AccountDialog editing an account', () => {
  const account = makeAccount({
    label: 'Acme',
    color: '#0ea5e9',
    env: [
      { key: 'TOKEN', value: null, secret: true },
      { key: 'BASE_URL', value: 'https://proxy.test', secret: false },
    ],
  })

  test('starts from the account and saves it', async () => {
    const onClose = vi.fn()
    edit(account, onClose)

    expect(screen.getByRole('heading').textContent).toBe('Edit account')
    expect(field('Label').value).toBe('Acme')
    input(field('Label'), 'Acme Corp')
    click('Save')
    await flush()

    expect(mocks.updateAccount).toHaveBeenCalledWith({
      id: 'a1',
      label: 'Acme Corp',
      color: '#0ea5e9',
      env: [
        { key: 'TOKEN', value: null, secret: true },
        { key: 'BASE_URL', value: 'https://proxy.test', secret: false },
      ],
    })
    expect(mocks.createAccount).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
    expect(shown()).toEqual(['success: Saved Acme Corp'])
  })

  test('a stored secret shows the keep placeholder and no value', () => {
    edit(account)

    const [token, baseUrl] = screen.getAllByLabelText('Value') as HTMLInputElement[]
    expect(token.placeholder).toBe(STORED)
    expect(token.value).toBe('')
    expect(token.type).toBe('password')
    expect(baseUrl.placeholder).not.toBe(STORED)
    expect(baseUrl.value).toBe('https://proxy.test')
  })

  test('typing a value replaces the stored secret', async () => {
    edit(account)

    input(screen.getAllByLabelText('Value')[0], 'rotated')
    click('Save')
    await flush()

    expect(mocks.updateAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [
        { key: 'TOKEN', value: 'rotated', secret: true },
        { key: 'BASE_URL', value: 'https://proxy.test', secret: false },
      ],
    }))
  })

  test('a secret turned plain has nothing stored to keep', async () => {
    edit(account)
    const token = screen.getAllByLabelText('Value')[0] as HTMLInputElement

    fireEvent.click(screen.getAllByLabelText('Secret')[0])

    expect(token.placeholder).not.toBe(STORED)
    expect(token.type).toBe('text')
    click('Save')
    await flush()
    // Empty and plain: the backend says it needs a value.
    expect(mocks.updateAccount).toHaveBeenCalledWith(expect.objectContaining({
      env: [
        { key: 'TOKEN', value: '', secret: false },
        { key: 'BASE_URL', value: 'https://proxy.test', secret: false },
      ],
    }))
  })

  test('a renamed secret has nothing stored under its new name', () => {
    edit(account)
    const token = screen.getAllByLabelText('Value')[0] as HTMLInputElement

    input(screen.getAllByLabelText('Variable name')[0], 'OTHER_TOKEN')

    expect(token.placeholder).not.toBe(STORED)
  })

  test('a plain variable turned secret has nothing stored either', () => {
    edit(account)
    const baseUrl = screen.getAllByLabelText('Value')[1] as HTMLInputElement

    fireEvent.click(screen.getAllByLabelText('Secret')[1])

    expect(baseUrl.type).toBe('password')
    expect(baseUrl.placeholder).not.toBe(STORED)
  })

  test('errors keep the dialog open, as when adding', async () => {
    mocks.updateAccount.mockRejectedValue(invalid)
    const onClose = vi.fn()
    edit(account, onClose)

    click('Save')
    await flush()

    expect(toasts().map((t) => t.message)).toEqual(['Give the account a name.'])
    expect(onClose).not.toHaveBeenCalled()
  })

  test('the saved snapshot is not applied here either', async () => {
    mocks.updateAccount.mockResolvedValue({ accounts: [makeAccount({ label: 'Other' })], defaults: [], projectAccounts: [] })
    edit(account)

    click('Save')
    await flush()

    expect(accountsState.accounts).toEqual([])
  })
})
