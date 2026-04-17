import { taskById } from './tasks'

const STORAGE_KEY = 'verun:recentFilesByProject'
const MAX_RECENT_FILES = 100

interface RecentFilesByProject {
  [projectId: string]: string[]
}

function loadRecentFiles(): RecentFilesByProject {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: RecentFilesByProject = {}
    for (const [projectId, paths] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(paths)) continue
      out[projectId] = paths.filter((path): path is string => typeof path === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function persistRecentFiles(next: RecentFilesByProject) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

let recentFilesByProject = loadRecentFiles()

export function recentFilesForProject(projectId: string | null | undefined): string[] {
  if (!projectId) return []
  return recentFilesByProject[projectId] ?? []
}

export function recentFilesForTask(taskId: string | null | undefined): string[] {
  if (!taskId) return []
  const task = taskById(taskId)
  return task ? recentFilesForProject(task.projectId) : []
}

export function recordRecentFileOpen(taskId: string, relativePath: string) {
  if (!relativePath || relativePath.startsWith('__diff__:')) return
  const task = taskById(taskId)
  if (!task) return

  const current = recentFilesByProject[task.projectId] ?? []
  const next = [relativePath, ...current.filter(path => path !== relativePath)].slice(0, MAX_RECENT_FILES)
  recentFilesByProject = { ...recentFilesByProject, [task.projectId]: next }
  persistRecentFiles(recentFilesByProject)
}

export function removeRecentFile(projectId: string, relativePath: string) {
  const current = recentFilesByProject[projectId] ?? []
  const next = current.filter(path => path !== relativePath)

  if (next.length === current.length) return

  recentFilesByProject = next.length > 0
    ? { ...recentFilesByProject, [projectId]: next }
    : Object.fromEntries(Object.entries(recentFilesByProject).filter(([id]) => id !== projectId))
  persistRecentFiles(recentFilesByProject)
}

export function clearRecentFilesForProject(projectId: string) {
  if (!(projectId in recentFilesByProject)) return
  recentFilesByProject = Object.fromEntries(
    Object.entries(recentFilesByProject).filter(([id]) => id !== projectId),
  )
  persistRecentFiles(recentFilesByProject)
}
