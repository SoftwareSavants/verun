import { invoke } from '@tauri-apps/api/core'
import type { Project, Task, TaskWithSession, Session, OutputLine, RepoInfo, Attachment, ClaudeSkill } from '../types'

// Projects
export const addProject = (repoPath: string) =>
  invoke<Project>('add_project', { repoPath })

export const listProjects = () =>
  invoke<Project[]>('list_projects')

export const deleteProject = (id: string) =>
  invoke<void>('delete_project', { id })

// Tasks
export const createTask = (projectId: string) =>
  invoke<TaskWithSession>('create_task', { projectId })

export const listTasks = (projectId: string) =>
  invoke<Task[]>('list_tasks', { projectId })

export const getTask = (id: string) =>
  invoke<Task | null>('get_task', { id })

export const deleteTask = (id: string) =>
  invoke<void>('delete_task', { id })

// Sessions
export const createSession = (taskId: string) =>
  invoke<Session>('create_session', { taskId })

export const sendMessage = (sessionId: string, message: string, attachments?: Attachment[], model?: string) =>
  invoke<void>('send_message', { sessionId, message, attachments, model })

export const closeSession = (sessionId: string) =>
  invoke<void>('close_session', { sessionId })

export const clearSession = (sessionId: string) =>
  invoke<void>('clear_session', { sessionId })

export const abortMessage = (sessionId: string) =>
  invoke<void>('abort_message', { sessionId })

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
export const listClaudeSkills = () =>
  invoke<ClaudeSkill[]>('list_claude_skills')

export const checkClaude = () =>
  invoke<string>('check_claude')

export const openInFinder = (path: string) =>
  invoke<void>('open_in_finder', { path })
