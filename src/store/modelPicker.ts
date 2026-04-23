import { createSignal } from 'solid-js'
import type { AgentType } from '../types'

export interface ModelPickerRequest {
  title?: string
  placeholder?: string
  defaultAgent?: AgentType
  defaultModel?: string
  onPick: (agentType: AgentType, model?: string) => void | Promise<void>
}

const [request, setRequest] = createSignal<ModelPickerRequest | null>(null)

export const modelPickerRequest = request

export function openModelPicker(req: ModelPickerRequest): void {
  setRequest(req)
}

export function closeModelPicker(): void {
  setRequest(null)
}
