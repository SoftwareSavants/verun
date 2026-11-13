import type { AttachmentRef } from '../types'
import { insertDictation } from '../lib/dictationInsert'
import { deserializeAttachments, serializeAttachments } from '../lib/binary'

// Composer drafts, persisted so they survive reloads and are visible to every
// window (localStorage is shared across webviews). A draft id is a session id
// (the chat composer) or `newTaskDraftId(projectId)` (a project's new-task box).
// The composer reads them when it switches to a session, so seeding one before
// selecting a session pre-fills its composer.

const NEW_TASK_PREFIX = 'new-task:'

/** The draft id of `projectId`'s new-task box. Never a session id (those are UUIDs). */
export const newTaskDraftId = (projectId: string) => `${NEW_TASK_PREFIX}${projectId}`

/** The project of a new-task draft id; `null` for a session's draft. */
export function newTaskDraftProject(draftId: string): string | null {
  return draftId.startsWith(NEW_TASK_PREFIX) ? draftId.slice(NEW_TASK_PREFIX.length) : null
}

const msgKey = (sid: string) => `verun:draft-msg:${sid}`
const attKey = (sid: string) => `verun:draft-att:${sid}`

export function loadDraftMessage(sid: string): string | null {
  return localStorage.getItem(msgKey(sid))
}

export function saveDraftMessage(sid: string, message: string) {
  if (message) localStorage.setItem(msgKey(sid), message)
  else localStorage.removeItem(msgKey(sid))
}

type DraftAppended = (sid: string, take: string) => void
const appendListeners = new Set<DraftAppended>()

/** Called after `appendToDraft`, so a composer holding that draft in memory can take the text too. */
export function onDraftAppended(cb: DraftAppended): () => void {
  appendListeners.add(cb)
  return () => { appendListeners.delete(cb) }
}

/** Append a dictated take to a draft, for a composer or new-task box that is not showing it. */
export function appendToDraft(sid: string, take: string) {
  saveDraftMessage(sid, insertDictation(loadDraftMessage(sid) ?? '', take, null).text)
  for (const cb of [...appendListeners]) cb(sid, take)
}

export function loadDraftAttachments(sid: string): AttachmentRef[] {
  const raw = localStorage.getItem(attKey(sid))
  if (!raw) return []
  try {
    return deserializeAttachments(raw)
  } catch {
    return []
  }
}

export function saveDraftAttachments(sid: string, attachments: AttachmentRef[]) {
  if (attachments.length > 0) localStorage.setItem(attKey(sid), serializeAttachments(attachments))
  else localStorage.removeItem(attKey(sid))
}

export function clearDraft(sid: string) {
  localStorage.removeItem(msgKey(sid))
  localStorage.removeItem(attKey(sid))
}
