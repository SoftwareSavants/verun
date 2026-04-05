import { invoke } from '@tauri-apps/api/core'
import type { Project, Task, Session, OutputLine, RepoInfo } from '../types'

// Projects
export const addProject = (repoPath: string) =>
  invoke<Project>('add_project', { repoPath })

export const listProjects = () =>
  invoke<Project[]>('list_projects')

export const deleteProject = (id: string) =>
  invoke<void>('delete_project', { id })

// Tasks
export const createTask = (projectId: string) =>
  invoke<Task>('create_task', { projectId })

export const listTasks = (projectId: string) =>
  invoke<Task[]>('list_tasks', { projectId })

export const getTask = (id: string) =>
  invoke<Task | null>('get_task', { id })

export const deleteTask = (id: string) =>
  invoke<void>('delete_task', { id })

// Sessions
export const startSession = (taskId: string) =>
  invoke<Session>('start_session', { taskId })

export const resumeSession = (sessionId: string) =>
  invoke<Session>('resume_session', { sessionId })

export const stopSession = (sessionId: string) =>
  invoke<void>('stop_session', { sessionId })

export const listSessions = (taskId: string) =>
  invoke<Session[]>('list_sessions', { taskId })

export const getSession = (id: string) =>
  invoke<Session | null>('get_session', { id })

export const getOutputLines = (sessionId: string) =>
  invoke<OutputLine[]>('get_output_lines', { sessionId })

// Git / Worktree
export const getDiff = (taskId: string) =>
  invoke<string>('get_diff', { taskId })

export const mergeBranch = (taskId: string, targetBranch: string) =>
  invoke<void>('merge_branch', { taskId, targetBranch })

export const getBranchStatus = (taskId: string) =>
  invoke<[number, number]>('get_branch_status', { taskId })

export const getRepoInfo = (path: string) =>
  invoke<RepoInfo>('get_repo_info', { path })

// Utility
export const openInFinder = (path: string) =>
  invoke<void>('open_in_finder', { path })
