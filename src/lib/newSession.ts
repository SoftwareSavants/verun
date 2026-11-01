import type { AccountSelection, Session } from '../types'
import { createSession } from '../store/sessions'
import { setSelectedSessionIdForTask } from '../store/ui'
import { setMainView } from '../store/editorView'
import { toastError } from './accountErrors'

/**
 * Starts a session in `taskId` and brings it up: its tab is selected and the
 * task shows sessions. `account` is the one it runs on, the project's account
 * for the harness when left out.
 *
 * When it cannot start the user is told: an account problem (the account
 * picked was removed, say) as its toast with the way to fix it, anything else
 * as an error toast. Resolves the session, or `null` after that toast.
 */
export async function openNewSession(taskId: string, agentType: string, model?: string, account?: AccountSelection): Promise<Session | null> {
  let session: Session
  try {
    session = await createSession(taskId, agentType, model, account)
  } catch (e) {
    toastError(e)
    return null
  }
  setSelectedSessionIdForTask(taskId, session.id)
  setMainView(taskId, 'session')
  return session
}
