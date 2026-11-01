import { describe, test, expect, beforeEach, vi } from 'vitest'

const ctx = vi.hoisted(() => ({ isTaskWindow: false }))
const consumePendingNav = vi.fn()
const taskById = vi.fn()
const focusCurrentWindow = vi.fn().mockResolvedValue(undefined)
const openTaskWindow = vi.fn().mockResolvedValue(undefined)
const ui = vi.hoisted(() => ({
  selectedTaskId: vi.fn(() => null as string | null),
  isTaskWindowed: vi.fn(() => false),
  focusOrSelectTask: vi.fn(),
  setPendingSessionNav: vi.fn(),
  setSelectedSessionIdForTask: vi.fn(),
}))

vi.mock('./windowContext', () => ({ get isTaskWindow() { return ctx.isTaskWindow } }))
vi.mock('./notifications', () => ({ consumePendingNav: (id: number) => consumePendingNav(id) }))
vi.mock('../store/tasks', () => ({ taskById: (id: string) => taskById(id) }))
vi.mock('./ipc', () => ({
  focusCurrentWindow: () => focusCurrentWindow(),
  openTaskWindow: (...a: unknown[]) => openTaskWindow(...a),
}))
vi.mock('../store/ui', () => ui)

import { handleNotificationClick } from './notificationClick'

const task = { id: 't-1', projectId: 'p-1', name: 'Task one' }

describe('handleNotificationClick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ctx.isTaskWindow = false
    ui.selectedTaskId.mockReturnValue(null)
    ui.isTaskWindowed.mockReturnValue(false)
    taskById.mockReturnValue(task)
  })

  test('ignores clicks for notifications this window did not send', () => {
    consumePendingNav.mockReturnValue(undefined)
    handleNotificationClick(7)
    expect(focusCurrentWindow).not.toHaveBeenCalled()
    expect(ui.focusOrSelectTask).not.toHaveBeenCalled()
    expect(openTaskWindow).not.toHaveBeenCalled()
  })

  test('main window: selects task, queues session, focuses itself', () => {
    consumePendingNav.mockReturnValue({ taskId: 't-1', sessionId: 's-1' })
    handleNotificationClick(1)
    expect(ui.setPendingSessionNav).toHaveBeenCalledWith('s-1', 't-1')
    expect(ui.focusOrSelectTask).toHaveBeenCalledWith(task)
    expect(focusCurrentWindow).toHaveBeenCalled()
  })

  test('main window: task already selected switches session directly', () => {
    ui.selectedTaskId.mockReturnValue('t-1')
    consumePendingNav.mockReturnValue({ taskId: 't-1', sessionId: 's-2' })
    handleNotificationClick(1)
    expect(ui.setSelectedSessionIdForTask).toHaveBeenCalledWith('t-1', 's-2')
    expect(focusCurrentWindow).toHaveBeenCalled()
  })

  test('main window: task open in its own window focuses that window, not main', () => {
    ui.isTaskWindowed.mockReturnValue(true)
    consumePendingNav.mockReturnValue({ taskId: 't-1', sessionId: 's-1' })
    handleNotificationClick(1)
    expect(openTaskWindow).toHaveBeenCalledWith('t-1', 'Task one')
    expect(focusCurrentWindow).not.toHaveBeenCalled()
    expect(ui.focusOrSelectTask).not.toHaveBeenCalled()
  })

  test('task window: switches session and focuses itself without changing task', () => {
    ctx.isTaskWindow = true
    consumePendingNav.mockReturnValue({ taskId: 't-1', sessionId: 's-3' })
    handleNotificationClick(1)
    expect(ui.setSelectedSessionIdForTask).toHaveBeenCalledWith('t-1', 's-3')
    expect(ui.focusOrSelectTask).not.toHaveBeenCalled()
    expect(focusCurrentWindow).toHaveBeenCalled()
  })
})
