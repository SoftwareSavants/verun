import { createSignal } from 'solid-js'
import type { AccountSelection, AgentType } from '../types'

export interface ModelPickerRequest {
  title?: string
  placeholder?: string
  /** The project the session is for: its account for each harness is the one listed first. */
  projectId?: string
  defaultAgent?: AgentType
  defaultModel?: string
  /** `account` is the choice of the row picked; a harness without accounts has none. */
  onPick: (agentType: AgentType, model?: string, account?: AccountSelection) => void | Promise<void>
}

const [request, setRequest] = createSignal<ModelPickerRequest | null>(null)

export const modelPickerRequest = request

export function openModelPicker(req: ModelPickerRequest): void {
  setRequest(req)
}

export function closeModelPicker(): void {
  setRequest(null)
}
