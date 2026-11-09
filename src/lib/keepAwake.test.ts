import { expect, test } from 'vitest'
import { keepAwakeSummary, type KeepAwakeStatus } from './keepAwake'

const off: KeepAwakeStatus = { agentsWorking: false, manualUntil: null, manualForever: false, active: false, keepsScreenOn: false }
const at = (h: number, m: number) => new Date(2026, 10, 8, h, m).getTime()

test('says plainly why the Mac is kept awake, or that it is not', () => {
  expect(keepAwakeSummary(off, true)).toBe('Not keeping your Mac awake')
  expect(keepAwakeSummary({ ...off, agentsWorking: true, active: true }, true)).toBe('Keeping your Mac awake while agents work')
  expect(keepAwakeSummary({ ...off, manualForever: true, active: true, keepsScreenOn: true }, true)).toBe('Screen on until you turn it off')
  expect(keepAwakeSummary({ ...off, manualUntil: at(15, 45), active: true, keepsScreenOn: true }, true)).toMatch(/^Screen on until 3:45/)
})

test('explains when auto mode is off', () => {
  expect(keepAwakeSummary(off, false)).toBe('Not keeping your Mac awake (auto is off)')
})
