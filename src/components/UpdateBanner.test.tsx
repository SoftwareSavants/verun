import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'

const working = vi.hoisted(() => ({ count: 0 }))
const restartApp = vi.hoisted(() => vi.fn())
vi.mock('../lib/updater', () => ({
  updateAvailable: () => ({ version: '9.9.9', body: '' }),
  updateProgress: () => 100, updateReady: () => true, updateError: () => null,
  updateChecking: () => false, updateUpToDate: () => false, dismissed: () => false,
  downloadAndInstall: vi.fn(), restartApp, dismissUpdate: vi.fn(),
}))
vi.mock('../store/taskStatus', () => ({ workingTaskCount: () => working.count }))

import { UpdateToast } from './UpdateBanner'
afterEach(() => { cleanup(); restartApp.mockReset() })

describe('UpdateToast restart', () => {
  test('restarts straight away when nothing is working', () => {
    working.count = 0
    render(() => <UpdateToast />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(restartApp).toHaveBeenCalledOnce()
  })

  test('asks first when agents are working, since restarting stops them', () => {
    working.count = 2
    render(() => <UpdateToast />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(restartApp).not.toHaveBeenCalled()
    expect(screen.getByText('2 tasks are still working. Restarting stops them.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText(/still working/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart anyway' }))
    expect(restartApp).toHaveBeenCalledOnce()
  })
})
