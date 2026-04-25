import { createStore, produce } from 'solid-js/store'
import type { Step, AttachmentRef } from '../types'
import * as ipc from '../lib/ipc'
import { serializeAttachments } from '../lib/binary'

// Store: sessionId -> Step[]
const [stepStore, setStepStore] = createStore<Record<string, Step[]>>({})

/** Load steps from DB for a session */
export async function loadSteps(sessionId: string) {
  const list = await ipc.listSteps(sessionId)
  setStepStore(sessionId, list)
}

/** Reactive read accessor */
export function getSteps(sessionId: string | undefined | null): Step[] {
  if (!sessionId) return []
  return stepStore[sessionId] || []
}

/** Add a step — optimistic store update + fire-and-forget DB write. Caller
 *  must already have uploaded any pasted bytes to the blob store and pass refs. */
export function addStep(opts: {
  sessionId: string
  message: string
  attachments?: AttachmentRef[]
  armed: boolean
  model?: string
  planMode?: boolean
  thinkingMode?: boolean
  fastMode?: boolean
}) {
  const id = crypto.randomUUID()
  const existing = stepStore[opts.sessionId] || []
  const sortOrder = existing.length > 0
    ? existing[existing.length - 1].sortOrder + 1
    : 0
  const attachmentsJson = opts.attachments && opts.attachments.length > 0
    ? serializeAttachments(opts.attachments)
    : null

  const step: Step = {
    id,
    sessionId: opts.sessionId,
    message: opts.message,
    attachmentsJson,
    armed: opts.armed,
    model: opts.model ?? null,
    planMode: opts.planMode ?? null,
    thinkingMode: opts.thinkingMode ?? null,
    fastMode: opts.fastMode ?? null,
    sortOrder,
    createdAt: Date.now(),
  }

  setStepStore(produce(store => {
    if (!store[opts.sessionId]) store[opts.sessionId] = []
    store[opts.sessionId].push(step)
  }))

  ipc.addStep(id, opts.sessionId, step.message, attachmentsJson, step.armed,
    step.model, step.planMode, step.thinkingMode, step.fastMode, sortOrder)
}

/** Remove a step */
export function removeStep(sessionId: string, stepId: string) {
  setStepStore(produce(store => {
    const list = store[sessionId]
    if (!list) return
    const idx = list.findIndex(s => s.id === stepId)
    if (idx !== -1) list.splice(idx, 1)
  }))
  ipc.deleteStep(stepId)
}

/** Update step fields */
export function updateStep(sessionId: string, stepId: string, updates: { message?: string; armed?: boolean; model?: string | null; planMode?: boolean | null; thinkingMode?: boolean | null; fastMode?: boolean | null; attachmentsJson?: string | null }) {
  let finalMsg = ''
  let finalArmed = false
  let finalModel: string | null = null
  let finalPlanMode: boolean | null = null
  let finalThinkingMode: boolean | null = null
  let finalFastMode: boolean | null = null
  let finalAttachmentsJson: string | null = null
  setStepStore(produce(store => {
    const list = store[sessionId]
    if (!list) return
    const step = list.find(s => s.id === stepId)
    if (!step) return
    if (updates.message !== undefined) step.message = updates.message
    if (updates.armed !== undefined) step.armed = updates.armed
    if (updates.model !== undefined) step.model = updates.model
    if (updates.planMode !== undefined) step.planMode = updates.planMode
    if (updates.thinkingMode !== undefined) step.thinkingMode = updates.thinkingMode
    if (updates.fastMode !== undefined) step.fastMode = updates.fastMode
    if (updates.attachmentsJson !== undefined) step.attachmentsJson = updates.attachmentsJson
    finalMsg = step.message
    finalArmed = step.armed
    finalModel = step.model
    finalPlanMode = step.planMode
    finalThinkingMode = step.thinkingMode
    finalFastMode = step.fastMode
    finalAttachmentsJson = step.attachmentsJson
  }))
  ipc.updateStep(stepId, finalMsg, finalArmed, finalModel, finalPlanMode, finalThinkingMode, finalFastMode, finalAttachmentsJson)
}

/** Reorder steps after drag-and-drop */
export function reorderSteps(sessionId: string, orderedIds: string[]) {
  setStepStore(produce(store => {
    const list = store[sessionId]
    if (!list) return
    const map = new Map(list.map(s => [s.id, s]))
    store[sessionId] = orderedIds
      .map((id, i) => {
        const s = map.get(id)!
        s.sortOrder = i
        return s
      })
  }))
  ipc.reorderSteps(sessionId, orderedIds)
}

/** Disarm all steps (on error) — keep them but set armed=false */
export function disarmAllSteps(sessionId: string) {
  setStepStore(produce(store => {
    const list = store[sessionId]
    if (!list) return
    for (const s of list) s.armed = false
  }))
  ipc.disarmAllSteps(sessionId)
}

/** Dequeue the first armed step — removes from store + DB, returns it */
export function dequeueArmedStep(sessionId: string): Step | undefined {
  const list = stepStore[sessionId]
  if (!list || list.length === 0) return undefined
  const idx = list.findIndex(s => s.armed)
  if (idx === -1) return undefined

  let result: Step | undefined
  setStepStore(produce(store => {
    const arr = store[sessionId]
    if (!arr) return
    result = { ...arr[idx] }
    arr.splice(idx, 1)
  }))
  if (result) ipc.deleteStep(result.id)
  return result
}

/** Extract a specific step by ID — removes from store + DB, returns it */
export function extractStep(sessionId: string, stepId: string): Step | undefined {
  let result: Step | undefined
  setStepStore(produce(store => {
    const list = store[sessionId]
    if (!list) return
    const idx = list.findIndex(s => s.id === stepId)
    if (idx === -1) return
    result = { ...list[idx] }
    list.splice(idx, 1)
  }))
  if (result) ipc.deleteStep(result.id)
  return result
}

/** Clear all steps for a session */
export function clearSteps(sessionId: string) {
  const list = stepStore[sessionId]
  if (list) {
    for (const s of list) ipc.deleteStep(s.id)
  }
  setStepStore(produce(store => { delete store[sessionId] }))
}
