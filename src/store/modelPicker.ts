import { createSignal } from 'solid-js'
import type { AccountSelection, AgentType } from '../types'

export interface ModelPickerRequest {
  title?: string
  placeholder?: string
  /** The project the session is for: its account for each harness is the one listed first. */
  projectId?: string
  defaultAgent?: AgentType
  defaultModel?: string
  /**
   * The account the session this was opened from runs on: an account's id, or
   * `null` for Default. Once its harness has accounts, "Current" goes to the group
   * of that account only. Left out, it goes to every group of the harness.
   */
  defaultAccountId?: string | null
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
