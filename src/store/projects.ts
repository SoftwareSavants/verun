import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import type { Project } from '../types'
import * as ipc from '../lib/ipc'
import { selectedTaskId, selectedProjectId, setSelectedProjectId, setSelectedTaskId, setSelectedSessionId } from './ui'
import { taskById } from './tasks'

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

  // Clear selection if the selected task belongs to the deleted project
  const tid = selectedTaskId()
  if (tid) {
    const task = taskById(tid)
    if (!task || task.projectId === id) {
      setSelectedTaskId(null)
      setSelectedSessionId(null)
    }
  }
  if (selectedProjectId() === id) {
    setSelectedProjectId(null)
  }
}

export async function updateBaseBranch(id: string, baseBranch: string) {
  await ipc.updateProjectBaseBranch(id, baseBranch)
  setProjects(p => p.id === id, 'baseBranch', baseBranch)
}

export async function updateHooks(id: string, setupHook: string, destroyHook: string, startCommand: string, autoStart: boolean) {
  await ipc.updateProjectHooks(id, setupHook, destroyHook, startCommand, autoStart)
  setProjects(produce(list => {
    const p = list.find(p => p.id === id)
    if (p) { p.setupHook = setupHook; p.destroyHook = destroyHook; p.startCommand = startCommand; p.autoStart = autoStart }
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

export function updateProjectDefaultAgentInStore(id: string, defaultAgentType: import('../types').AgentType) {
  setProjects(p => p.id === id, 'defaultAgentType', defaultAgentType)
}

// Listen for hooks auto-applied by Claude auto-detect
export async function initProjectListeners() {
  await listen<{ projectId: string; setupHook: string; destroyHook: string; startCommand: string }>('project-hooks-updated', (event) => {
    const { projectId, setupHook, destroyHook, startCommand } = event.payload
    updateStoreHooks(projectId, setupHook, destroyHook, startCommand)
  })
}
