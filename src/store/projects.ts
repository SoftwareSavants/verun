import { createStore, produce } from 'solid-js/store'
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

export const projectById = (id: string) =>
  projects.find(p => p.id === id)
