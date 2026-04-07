import { invoke } from '@tauri-apps/api/core'
import type { Project, Task, TaskWithSession, Session, OutputLine, RepoInfo, Attachment, ClaudeSkill, GitStatus, FileDiff, GitHubRepo, PrInfo, CiCheck } from '../types'

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

export const respondToApproval = (requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>) =>
  invoke<void>('respond_to_approval', { requestId, behavior, updatedInput })

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

// Git operations
export const getGitStatus = (taskId: string) =>
  invoke<GitStatus>('get_git_status', { taskId })

export const getFileDiff = (taskId: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_file_diff', { taskId, filePath, contextLines, ignoreWhitespace })

export const getFileContext = (taskId: string, filePath: string, startLine: number, endLine: number, version: 'old' | 'new') =>
  invoke<string[]>('get_file_context', { taskId, filePath, startLine, endLine, version })

export const gitStage = (taskId: string, paths: string[]) =>
  invoke<void>('git_stage', { taskId, paths })

export const gitUnstage = (taskId: string, paths: string[]) =>
  invoke<void>('git_unstage', { taskId, paths })

export const gitCommit = (taskId: string, message: string) =>
  invoke<string>('git_commit', { taskId, message })

export const gitPush = (taskId: string) =>
  invoke<void>('git_push', { taskId })

export const gitPull = (taskId: string) =>
  invoke<string>('git_pull', { taskId })

export const gitCommitAndPush = (taskId: string, message: string) =>
  invoke<string>('git_commit_and_push', { taskId, message })

// GitHub
export const checkGithub = (taskId: string) =>
  invoke<GitHubRepo | null>('check_github', { taskId })

export const createPullRequest = (taskId: string, title: string, body: string, base: string) =>
  invoke<PrInfo>('create_pull_request', { taskId, title, body, base })

export const getPullRequest = (taskId: string) =>
  invoke<PrInfo | null>('get_pull_request', { taskId })

export const gitShip = (taskId: string, commitMessage: string, prTitle: string, prBody: string, base: string) =>
  invoke<PrInfo>('git_ship', { taskId, commitMessage, prTitle, prBody, base })

export const getCiChecks = (taskId: string) =>
  invoke<CiCheck[]>('get_ci_checks', { taskId })

export const getBranchUrl = (taskId: string) =>
  invoke<string | null>('get_branch_url', { taskId })

export const hasConflicts = (taskId: string) =>
  invoke<boolean>('has_conflicts', { taskId })

// Utility
export const listClaudeSkills = () =>
  invoke<ClaudeSkill[]>('list_claude_skills')

export const checkClaude = () =>
  invoke<string>('check_claude')

export const openInFinder = (path: string) =>
  invoke<void>('open_in_finder', { path })
