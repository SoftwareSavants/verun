import { consumePendingNav } from './notifications'
import { isTaskWindow } from './windowContext'
import { taskById } from '../store/tasks'
import { focusCurrentWindow, openTaskWindow } from './ipc'
import {
  selectedTaskId,
  isTaskWindowed,
  focusOrSelectTask,
  setPendingSessionNav,
  setSelectedSessionIdForTask,
} from '../store/ui'

/**
 * Navigate to the task+session a clicked notification refers to. Click events
 * are broadcast to every window, so only the window that sent the notification
 * (the one holding its id) reacts.
 */
export function handleNotificationClick(id: number) {
  const nav = consumePendingNav(id)
  if (!nav) return
  const task = taskById(nav.taskId)
  if (!task) return

  // A task window only ever shows its own task — just switch session.
  if (isTaskWindow) {
    setSelectedSessionIdForTask(nav.taskId, nav.sessionId)
    focusCurrentWindow().catch(() => {})
    return
  }

  // Task was detached after the notification fired — focus its window instead.
  if (isTaskWindowed(task.id)) {
    openTaskWindow(task.id, task.name || undefined).catch(() => {})
    return
  }

  // The selection effect only consumes pending nav when the task changes.
  if (selectedTaskId() === task.id) setSelectedSessionIdForTask(task.id, nav.sessionId)
  else setPendingSessionNav(nav.sessionId, task.id)
  focusOrSelectTask(task)
  focusCurrentWindow().catch(() => {})
}
