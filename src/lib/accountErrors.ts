import { addToast, openSettings, type AddToastOptions } from '../store/ui'

/**
 * Starts the error string of an IPC command that failed because of an account.
 * The backend builds it in `AccountError::to_ipc` (src-tauri/src/accounts/mod.rs),
 * and the rest of the string is the JSON of `AccountErrorPayload`.
 */
const ACCOUNT_ERROR_PREFIX = 'ACCOUNT_ERROR:'

/** Why an account cannot be used or changed. What an error does not have is `null` (`projects`: empty). */
export interface AccountErrorPayload {
  kind: 'removed' | 'signedOut' | 'missing' | 'wrongHarness' | 'secret' | 'busy' | 'inUse' | 'invalid'
  accountId: string | null
  label: string | null
  projects: string[]
  message: string | null
}

/** `err` as an account error, or `null` when it is any other error. */
export function parseAccountError(err: unknown): AccountErrorPayload | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!text.startsWith(ACCOUNT_ERROR_PREFIX)) return null
  let json: unknown
  try {
    json = JSON.parse(text.slice(ACCOUNT_ERROR_PREFIX.length))
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const payload = json as Partial<AccountErrorPayload>
  if (typeof payload.kind !== 'string') return null
  return {
    kind: payload.kind,
    accountId: payload.accountId ?? null,
    label: payload.label ?? null,
    projects: payload.projects ?? [],
    message: payload.message ?? null,
  }
}

/** The toast an account error is shown as. */
interface AccountToast {
  title: string
  message: string
  actions?: AddToastOptions['actions']
}

/** Takes the user to the accounts in Settings, where they log in or pick another. */
function toAccounts(label: string): AddToastOptions['actions'] {
  return [{ label, variant: 'primary', onClick: () => openSettings('accounts') }]
}

function toastFor(error: AccountErrorPayload): AccountToast {
  switch (error.kind) {
    case 'signedOut':
      return {
        title: 'Account signed out',
        message: `${error.label ?? 'This account'} is signed out.`,
        actions: toAccounts('Log in'),
      }
    case 'removed':
      return {
        title: 'Account removed',
        message: `${error.label ?? 'This account'} was removed. Start a new session on another account.`,
        actions: toAccounts('Choose account'),
      }
    case 'inUse':
      return {
        title: 'Account in use',
        message: `Used by ${error.projects.join(', ')}. Change those projects first.`,
      }
    case 'busy':
      return {
        title: 'Login already open',
        message: 'Finish or close the other login first.',
      }
    case 'secret':
      return {
        title: 'Keychain error',
        message: `Couldn't read a secret for ${error.label ?? 'an account'} from the keychain.`,
      }
    default:
      // missing, wrongHarness and invalid, and any kind a newer backend adds.
      // The first two come without a message.
      return {
        title: 'Account error',
        message: error.message ?? 'Something is wrong with this account.',
      }
  }
}

/**
 * `err` in words, if it is an account error: the sentence its toast shows. For
 * a place that keeps the problem on screen after the toast has gone.
 */
export function accountErrorMessage(err: unknown): string | null {
  const error = parseAccountError(err)
  return error ? toastFor(error).message : null
}

/** How long an account toast stays up: long enough to read it and act on it. */
const ACCOUNT_TOAST_MS = 15_000

/**
 * Shows the toast of an account error. It is filed under its kind and account,
 * so the same problem raised again (every retry, every action that runs into
 * it) replaces the toast that is up instead of stacking another one.
 */
function showToast(error: AccountErrorPayload): string {
  const { title, message, actions } = toastFor(error)
  addToast(message, 'error', {
    id: `account-error:${error.kind}:${error.accountId ?? 'none'}`,
    duration: ACCOUNT_TOAST_MS,
    title,
    actions,
  })
  return message
}

/**
 * Shows `err` as a toast with a way to fix it, if it is an account error.
 * Returns whether it was one, so the caller can skip its own handling:
 *
 *     try { await ipc.sendMessage(...) } catch (e) { if (!notifyAccountError(e)) throw e }
 */
export function notifyAccountError(err: unknown): boolean {
  const error = parseAccountError(err)
  if (!error) return false
  showToast(error)
  return true
}

/**
 * Tells the user that `err` went wrong, for a catch block with nothing to add:
 * an account problem as its toast with the way to fix it, any other error as an
 * error toast saying what it is.
 *
 *     try { await ipc.removeAccount(...) } catch (e) { toastError(e) }
 */
export function toastError(err: unknown): void {
  if (!notifyAccountError(err)) addToast(String(err), 'error')
}

/**
 * What to say about a failure in a place that keeps it on screen (a task's
 * row, the new-task draft, a menu). An account problem is told in words and
 * also raised as its toast, with the way to fix it, so the raw `ACCOUNT_ERROR:`
 * string never reaches the user. Any other error is `plain`.
 */
export function failureText(err: unknown, plain: string = String(err)): string {
  const error = parseAccountError(err)
  return error ? showToast(error) : plain
}
