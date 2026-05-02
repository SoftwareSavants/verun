import { createSignal } from 'solid-js'
import type { SideQuestionResponse } from '../types'

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
}

const [panel, setPanel] = createSignal<PanelData | null>(null)
const memory = new Map<string, RememberedSideQuestion>()
let openCounter = 0

/** Current panel data, or null when no panel is open. Drives both the
    `<Show>` mount in TaskPanel and the bubble visibility in ChatView. */
export const sideQuestionPanel = panel
export const sideQuestionPanelData = panel

export function openSideQuestion(sessionId: string, prefill?: string, autoSubmit = false) {
  openCounter += 1
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
  return memory.get(sessionId)
}

export function rememberSideQuestion(sessionId: string, state: RememberedSideQuestion) {
  memory.set(sessionId, state)
}

export function forgetSideQuestion(sessionId: string) {
  memory.delete(sessionId)
}
