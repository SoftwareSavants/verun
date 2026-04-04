import { invoke } from '@tauri-apps/api/core'
import type { Agent, Session, Worktree } from '../types'

// Agent lifecycle
export const spawnAgent = (repoPath: string, branch: string, prompt: string) =>
  invoke<Agent>('spawn_agent', { repoPath, branch, prompt })

export const killAgent = (agentId: string) =>
  invoke<void>('kill_agent', { agentId })

export const restartAgent = (agentId: string) =>
  invoke<void>('restart_agent', { agentId })

export const listAgents = () =>
  invoke<Agent[]>('list_agents')

// Worktree operations
export const createWorktree = (repoPath: string, branch: string) =>
  invoke<Worktree>('create_worktree', { repoPath, branch })

export const deleteWorktree = (worktreePath: string) =>
  invoke<void>('delete_worktree', { worktreePath })

export const listWorktrees = (repoPath: string) =>
  invoke<Worktree[]>('list_worktrees', { repoPath })

// Session
export const getSession = (agentId: string) =>
  invoke<Session>('get_session', { agentId })

// Filesystem
export const openInFinder = (path: string) =>
  invoke<void>('open_in_finder', { path })

// Git operations
export const getDiff = (worktreePath: string) =>
  invoke<string>('get_diff', { worktreePath })

export const mergeBranch = (worktreePath: string, targetBranch: string) =>
  invoke<void>('merge_branch', { worktreePath, targetBranch })
