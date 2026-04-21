import { describe, test, expect, beforeEach, vi } from 'vitest'

const pluginSend = vi.fn().mockResolvedValue(undefined)
const removeAllActive = vi.fn().mockResolvedValue(undefined)
const isPermissionGranted = vi.fn().mockResolvedValue(true)
const requestPermission = vi.fn().mockResolvedValue('granted')

vi.mock('@choochmeque/tauri-plugin-notifications-api', () => ({
  sendNotification: (...args: unknown[]) => pluginSend(...args),
  removeAllActive: () => removeAllActive(),
  isPermissionGranted: () => isPermissionGranted(),
  requestPermission: () => requestPermission(),
  onNotificationClicked: vi.fn(),
}))

vi.mock('../store/ui', () => ({
  selectedTaskId: vi.fn(() => null),
  addToast: vi.fn(),
  dismissToast: vi.fn(),
}))

import { notify, consumePendingNav, clearDeliveredNotifications } from './notifications'

describe('notifications JS flow', () => {
  let now = 1_000_000
  beforeEach(() => {
    pluginSend.mockClear()
    removeAllActive.mockClear()
    // Jump well past the 1s throttle between tests
    now += 60_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })

  test('notify passes numeric id to the plugin and stores nav data', async () => {
    await notify({ title: 'T', body: 'B', taskId: 't-A', sessionId: 's-A' })
    expect(pluginSend).toHaveBeenCalledTimes(1)
    const call = pluginSend.mock.calls[0][0] as { id: number; title: string; body: string; autoCancel: boolean }
    expect(typeof call.id).toBe('number')
    expect(call.title).toBe('T')
    expect(call.body).toBe('B')
    expect(call.autoCancel).toBe(true)

    expect(consumePendingNav(call.id)).toEqual({ taskId: 't-A', sessionId: 's-A' })
  })

  test('consumePendingNav removes the entry so a second read returns undefined', async () => {
    await notify({ title: 'T', body: 'B', taskId: 't-B', sessionId: 's-B' })
    const { id } = pluginSend.mock.calls[0][0] as { id: number }
    expect(consumePendingNav(id)).toEqual({ taskId: 't-B', sessionId: 's-B' })
    expect(consumePendingNav(id)).toBeUndefined()
  })

  test('consumePendingNav returns undefined for unknown ids', () => {
    expect(consumePendingNav(999_999)).toBeUndefined()
  })

  test('clearDeliveredNotifications calls the plugin removeAllActive', () => {
    clearDeliveredNotifications()
    expect(removeAllActive).toHaveBeenCalledTimes(1)
  })

  test('clearDeliveredNotifications swallows plugin errors', () => {
    removeAllActive.mockRejectedValueOnce(new Error('plugin unavailable'))
    expect(() => clearDeliveredNotifications()).not.toThrow()
  })

  test('nav entry is dropped when the plugin send throws', async () => {
    pluginSend.mockRejectedValueOnce(new Error('not bundled'))
    const before = consumePendingNav(123_456)
    expect(before).toBeUndefined()
    await notify({ title: 'T', body: 'B', taskId: 't-C', sessionId: 's-C' })
    // No successful send means no id was returned to the caller; verify the
    // map wasn't left with a stale entry by sweeping a range of plausible ids.
    for (let i = 1; i < 50; i++) expect(consumePendingNav(i)).toBeUndefined()
  })
})
