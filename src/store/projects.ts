import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Project } from '../types'
import * as ipc from '../lib/ipc'

export const [projects, setProjects] = createStore<Project[]>([])

export async function loadProjects() {
  const list = await ipc.listProjects()
  setProjects(list)
}

export async function addProject(repoPath: string): Promise<Project> {
  const project = await ipc.addProject(repoPath)
  setProjects(produce(p => p.push(project)))
  return project
}

export async function deleteProject(id: string) {
  await ipc.deleteProject(id)
  setProjects(prev => prev.filter(p => p.id !== id))
}

export async function updateBaseBranch(id: string, baseBranch: string) {
  await ipc.updateProjectBaseBranch(id, baseBranch)
  setProjects(p => p.id === id, 'baseBranch', baseBranch)
}

export async function updateHooks(id: string, setupHook: string, destroyHook: string, startCommand: string) {
  await ipc.updateProjectHooks(id, setupHook, destroyHook, startCommand)
  setProjects(produce(list => {
    const p = list.find(p => p.id === id)
    if (p) { p.setupHook = setupHook; p.destroyHook = destroyHook; p.startCommand = startCommand }
  }))
}

/** Update hooks in the local store only (no IPC call — use when DB is already updated) */
export function updateStoreHooks(id: string, setupHook: string, destroyHook: string, startCommand: string) {
  setProjects(produce(list => {
    const p = list.find(p => p.id === id)
    if (p) { p.setupHook = setupHook; p.destroyHook = destroyHook; p.startCommand = startCommand }
  }))
}

export const projectById = (id: string) =>
  projects.find(p => p.id === id)

// Listen for hooks auto-applied by Claude auto-detect
export async function initProjectListeners() {
  await listen<{ projectId: string; setupHook: string; destroyHook: string; startCommand: string }>('project-hooks-updated', (event) => {
    const { projectId, setupHook, destroyHook, startCommand } = event.payload
    updateStoreHooks(projectId, setupHook, destroyHook, startCommand)
  })
}
