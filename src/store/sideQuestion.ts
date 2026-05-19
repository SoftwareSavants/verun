import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { SideQuestionResponse } from '../types'
import { askSideQuestion } from '../lib/ipc'

interface PanelData {
  sessionId: string
  prefill?: string
  autoSubmit?: boolean
  /** Bumped on every open so the panel can detect re-opens with the same
      sessionId/prefill (forces re-seed via createEffect). */
  openId: number
}

export interface RememberedSideQuestion {
  question: string
  answer?: SideQuestionResponse | null
  error?: string | null
  /** A request is in flight for this session, possibly with the panel closed. */
  loading: boolean
  /** An answer (or error) arrived while the panel was closed for this session. */
  unread: boolean
}

const [panel, setPanel] = createSignal<PanelData | null>(null)
const [memory, setMemory] = createStore<Record<string, RememberedSideQuestion>>({})
let openCounter = 0

/** Current panel data, or null when no panel is open. Drives both the
    `<Show>` mount in TaskPanel and the bubble visibility in ChatView. */
export const sideQuestionPanel = panel
export const sideQuestionPanelData = panel

/** Reactive accessor for a single session's side-question state. */
export const sideQuestionState = (sessionId: string): RememberedSideQuestion | undefined =>
  memory[sessionId]

function blankState(question = ''): RememberedSideQuestion {
  return { question, answer: undefined, error: null, loading: false, unread: false }
}

export function openSideQuestion(sessionId: string, prefill?: string, autoSubmit = false) {
  openCounter += 1
  if (memory[sessionId]?.unread) {
    setMemory(sessionId, 'unread', false)
  }
  setPanel({ sessionId, prefill, autoSubmit, openId: openCounter })
}

export function toggleSideQuestion(sessionId: string) {
  if (panel()?.sessionId === sessionId) {
    closeSideQuestion()
  } else {
    openSideQuestion(sessionId)
  }
}

export function closeSideQuestion() {
  setPanel(null)
}

export function getRememberedSideQuestion(sessionId: string): RememberedSideQuestion | undefined {
  return memory[sessionId]
}

export function rememberSideQuestion(
  sessionId: string,
  partial: Partial<RememberedSideQuestion>,
) {
  setMemory(sessionId, prev => ({ ...(prev ?? blankState()), ...partial }))
}

export function forgetSideQuestion(sessionId: string) {
  setMemory(produce(store => { delete store[sessionId] }))
}

export function dismissSideQuestionUnread(sessionId: string) {
  if (memory[sessionId]) {
    setMemory(sessionId, 'unread', false)
  }
}

/** Kicks off a side question. Resolves when the request settles; safe to
    ignore — the store tracks loading/answer/error/unread on its own so the
    panel can unmount mid-flight and the pill can read the live state. */
export async function submitSideQuestion(sessionId: string, question: string): Promise<void> {
  setMemory(sessionId, { ...blankState(question), loading: true })
  try {
    const result = await askSideQuestion(sessionId, question)
    const stillOpen = panel()?.sessionId === sessionId
    setMemory(sessionId, prev => ({
      ...(prev ?? blankState(question)),
      loading: false,
      answer: result,
      error: null,
      unread: !stillOpen,
    }))
  } catch (e) {
    const stillOpen = panel()?.sessionId === sessionId
    setMemory(sessionId, prev => ({
      ...(prev ?? blankState(question)),
      loading: false,
      error: e instanceof Error ? e.message : String(e),
      unread: !stillOpen,
    }))
  }
}
