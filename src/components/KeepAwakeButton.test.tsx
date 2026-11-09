import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../lib/ipc', () => ({
  keepAwakeSetManual: vi.fn().mockResolvedValue(undefined),
  keepAwakeClearManual: vi.fn().mockResolvedValue(undefined),
  keepAwakeSetAgentsWorking: vi.fn().mockResolvedValue(undefined),
  keepAwakeStatus: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

import * as ipc from '../lib/ipc'
import { KeepAwakeButton } from './KeepAwakeButton'
import { keepAwakeAuto, setKeepAwakeStatus } from '../store/keepAwake'

afterEach(cleanup)
const idle = { agentsWorking: false, manualUntil: null, manualForever: false, active: false, keepsScreenOn: false }

test('keeps the screen on for a chosen time, or until turned off', async () => {
  setKeepAwakeStatus(idle)
  render(() => <KeepAwakeButton />)
  await fireEvent.click(screen.getByRole('button', { name: /Not keeping your Mac awake/ }))
  await fireEvent.click(screen.getByText('1 hour'))
  expect(ipc.keepAwakeSetManual).toHaveBeenCalledWith(60)
  await fireEvent.click(screen.getByRole('button', { name: /Not keeping/ }))
  await fireEvent.click(screen.getByText('Until I turn it off'))
  expect(ipc.keepAwakeSetManual).toHaveBeenCalledWith(null)
})

test('an active manual hold can be turned off, and auto mode toggled', async () => {
  setKeepAwakeStatus({ ...idle, manualForever: true, active: true, keepsScreenOn: true })
  render(() => <KeepAwakeButton />)
  const button = screen.getByRole('button', { name: /Screen on until you turn it off/ })
  expect(button.getAttribute('aria-pressed')).toBe('true')
  await fireEvent.click(button)
  await fireEvent.click(screen.getByText('Turn off'))
  expect(ipc.keepAwakeClearManual).toHaveBeenCalled()
  const before = keepAwakeAuto()
  await fireEvent.click(button)
  await fireEvent.click(screen.getByText('Keep awake while agents work'))
  expect(keepAwakeAuto()).toBe(!before)
})
