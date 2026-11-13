import { createMemo, createRoot, createSignal } from 'solid-js'
import { projects } from './projects'
import { activeTasksForProject } from './tasks'
import { visibleProjects } from './projectGroups'
import { needsYou, taskStatus } from './taskStatus'
import { lastActiveAt } from './lastActive'
import { sidebarView } from './sidebarView'
import { recentTasks } from '../lib/recentTasks'
import { sidebarOrder } from '../lib/sidebarOrder'

// The sidebar's lists, computed once and shared: the sidebar renders them and
// the keyboard shortcuts walk them, so the two can't disagree on the order.

// Ages and quiet folding only move once a minute.
const [minute, setMinute] = createSignal(Math.floor(Date.now() / 60_000) * 60_000)
setInterval(() => setMinute(Math.floor(Date.now() / 60_000) * 60_000), 60_000)
export { minute as sidebarMinute }

const lists = createRoot(() => {
  const byProject = createMemo(() => visibleProjects(projects).flatMap(p => activeTasksForProject(p.id)))
  // Everything blocked on the manager in the current scope, in sidebar order.
  const needsYouTasks = createMemo(() => byProject().filter(t => needsYou(t.id)))
  // Recent view: every task in scope in one list, newest first.
  const recent = createMemo(() => recentTasks(
    byProject().map(task => ({ id: task.id, task, column: taskStatus(task.id).column, lastActive: lastActiveAt(task) })),
    minute(),
  ))
  const order = createMemo(() => sidebarOrder(sidebarView(), {
    byProject: byProject(),
    recent: recent().recent.map(r => r.task),
    needsYou: needsYouTasks(),
  }))
  return { byProject, needsYouTasks, recent, order }
})

export const sidebarNeedsYou = lists.needsYouTasks
export const sidebarRecent = lists.recent
/** What ⌘1-9 count, in order. */
export const numberedTasks = () => lists.order().numbered
/** What ⌘⌥↑/↓ step through, top to bottom as on screen. */
export const navigationTasks = () => lists.order().navigation
