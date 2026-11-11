import { createSignal } from 'solid-js'

/** How the sidebar lists tasks: under their projects, or in one list by recent activity. */
export type SidebarView = 'projects' | 'recent'
const KEY = 'verun:sidebarView'
const read = (): SidebarView => { try { return localStorage.getItem(KEY) === 'recent' ? 'recent' : 'projects' } catch { return 'projects' } }
const [view, setView] = createSignal<SidebarView>(read())
export const sidebarView = view
export function setSidebarView(next: SidebarView) {
  setView(next)
  try { localStorage.setItem(KEY, next) } catch { /* storage blocked */ }
}
