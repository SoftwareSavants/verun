import type { HoldKey } from '../types/voice'

const NAMES: Record<HoldKey, string> = {
  'fn': 'Fn',
  'right-option': 'Right Option',
  'right-command': 'Right Command',
}

/** The dictation hold key as a Mac keyboard names it. */
export function holdKeyName(key: HoldKey): string {
  return NAMES[key]
}
