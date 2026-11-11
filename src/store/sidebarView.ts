import { createSignal } from 'solid-js'

/** How the sidebar lists tasks: under their projects, or grouped by status, newest first. */
export type SidebarView = 'projects' | 'status'
const KEY = 'verun:sidebarView'
const read = (): SidebarView => { try { return localStorage.getItem(KEY) === 'status' ? 'status' : 'projects' } catch { return 'projects' } }
const [view, setView] = createSignal<SidebarView>(read())
export const sidebarView = view
export function setSidebarView(next: SidebarView) {
  setView(next)
  try { localStorage.setItem(KEY, next) } catch { /* storage blocked */ }
}
