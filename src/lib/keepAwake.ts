export interface KeepAwakeStatus {
  agentsWorking: boolean
  /** Epoch ms when the manual hold ends; null when off or forever. */
  manualUntil: number | null
  manualForever: boolean
  active: boolean
  keepsScreenOn: boolean
}

/** Manual hold choices, in minutes; null = until turned off. */
export const KEEP_AWAKE_DURATIONS: { label: string; minutes: number | null }[] = [
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '4 hours', minutes: 240 },
  { label: 'Until I turn it off', minutes: null },
]

export function keepAwakeSummary(status: KeepAwakeStatus, autoEnabled: boolean): string {
  if (status.manualForever) return 'Screen on until you turn it off'
  if (status.manualUntil !== null && status.keepsScreenOn) {
    const time = new Date(status.manualUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `Screen on until ${time}`
  }
  if (status.active && status.agentsWorking) return 'Keeping your Mac awake while agents work'
  return autoEnabled ? 'Not keeping your Mac awake' : 'Not keeping your Mac awake (auto is off)'
}
