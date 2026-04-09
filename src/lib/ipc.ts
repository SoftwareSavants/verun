import { invoke } from '@tauri-apps/api/core'
import type { Project, Task, TaskWithSession, Session, OutputLine, RepoInfo, Attachment, ClaudeSkill, GitStatus, FileDiff, BranchCommit, GitHubRepo, PrInfo, CiCheck, ToolApprovalRequest, TrustLevel, AuditEntry, PtySpawnResult } from '../types'

// Projects
export const addProject = (repoPath: string) =>
  invoke<Project>('add_project', { repoPath })

export const listProjects = () =>
  invoke<Project[]>('list_projects')

export const deleteProject = (id: string) =>
  invoke<void>('delete_project', { id })

export const updateProjectBaseBranch = (id: string, baseBranch: string) =>
  invoke<void>('update_project_base_branch', { id, baseBranch })

// Tasks
export const createTask = (projectId: string, baseBranch?: string) =>
  invoke<TaskWithSession>('create_task', { projectId, baseBranch })

export const listTasks = (projectId: string) =>
  invoke<Task[]>('list_tasks', { projectId })

export const getTask = (id: string) =>
  invoke<Task | null>('get_task', { id })

export const deleteTask = (id: string) =>
  invoke<void>('delete_task', { id })

// Sessions
export const createSession = (taskId: string) =>
  invoke<Session>('create_session', { taskId })

export const sendMessage = (sessionId: string, message: string, attachments?: Attachment[], model?: string, planMode?: boolean, thinkingMode?: boolean, fastMode?: boolean) =>
  invoke<void>('send_message', { sessionId, message, attachments, model, planMode, thinkingMode, fastMode })

export const closeSession = (sessionId: string) =>
  invoke<void>('close_session', { sessionId })

export const clearSession = (sessionId: string) =>
  invoke<void>('clear_session', { sessionId })

export const abortMessage = (sessionId: string) =>
  invoke<void>('abort_message', { sessionId })

export const getActiveSessions = () =>
  invoke<string[]>('get_active_sessions')

export const respondToApproval = (requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>) =>
  invoke<void>('respond_to_approval', { requestId, behavior, updatedInput })

export const getPendingApprovals = () =>
  invoke<ToolApprovalRequest[]>('get_pending_approvals')

export const listSessions = (taskId: string) =>
  invoke<Session[]>('list_sessions', { taskId })

export const getSession = (id: string) =>
  invoke<Session | null>('get_session', { id })

export const getOutputLines = (sessionId: string) =>
  invoke<OutputLine[]>('get_output_lines', { sessionId })

// Policy / Trust levels
export const setTrustLevel = (taskId: string, trustLevel: TrustLevel) =>
  invoke<void>('set_trust_level', { taskId, trustLevel })

export const getTrustLevel = (taskId: string) =>
  invoke<string>('get_trust_level', { taskId })

export const getAuditLog = (taskId: string, limit?: number) =>
  invoke<AuditEntry[]>('get_audit_log', { taskId, limit })

// Git / Worktree
export const getDiff = (taskId: string) =>
  invoke<string>('get_diff', { taskId })

export const mergeBranch = (taskId: string, targetBranch: string) =>
  invoke<void>('merge_branch', { taskId, targetBranch })

export const getBranchStatus = (taskId: string) =>
  invoke<[number, number, number]>('get_branch_status', { taskId })

export const getRepoInfo = (path: string) =>
  invoke<RepoInfo>('get_repo_info', { path })

// Git operations
export const getGitStatus = (taskId: string) =>
  invoke<GitStatus>('get_git_status', { taskId })

export const getFileDiff = (taskId: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_file_diff', { taskId, filePath, contextLines, ignoreWhitespace })

export const getFileContext = (taskId: string, filePath: string, startLine: number, endLine: number, version: 'old' | 'new') =>
  invoke<string[]>('get_file_context', { taskId, filePath, startLine, endLine, version })

export const getBranchCommits = (taskId: string) =>
  invoke<BranchCommit[]>('get_branch_commits', { taskId })

export const getCommitFiles = (taskId: string, commitHash: string) =>
  invoke<GitStatus>('get_commit_files', { taskId, commitHash })

export const getCommitFileDiff = (taskId: string, commitHash: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_commit_file_diff', { taskId, commitHash, filePath, contextLines, ignoreWhitespace })

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

export const markPrReady = (taskId: string) =>
  invoke<void>('mark_pr_ready', { taskId })

export const mergePullRequest = (taskId: string) =>
  invoke<void>('merge_pull_request', { taskId })

export const gitShip = (taskId: string, commitMessage: string, prTitle: string, prBody: string, base: string) =>
  invoke<PrInfo>('git_ship', { taskId, commitMessage, prTitle, prBody, base })

export const getCiChecks = (taskId: string) =>
  invoke<CiCheck[]>('get_ci_checks', { taskId })

export const getBranchUrl = (taskId: string) =>
  invoke<string | null>('get_branch_url', { taskId })

export const hasConflicts = (taskId: string) =>
  invoke<boolean>('has_conflicts', { taskId })

// File listing
export const listWorktreeFiles = (taskId: string) =>
  invoke<string[]>('list_worktree_files', { taskId })

// Utility
export const listClaudeSkills = () =>
  invoke<ClaudeSkill[]>('list_claude_skills')

export const checkClaude = () =>
  invoke<string>('check_claude')

export const openInFinder = (path: string) =>
  invoke<void>('open_in_finder', { path })

export const openInApp = (path: string, app: string) =>
  invoke<void>('open_in_app', { path, app })

// PTY / Terminal
export const ptySpawn = (taskId: string, rows: number, cols: number) =>
  invoke<PtySpawnResult>('pty_spawn', { taskId, rows, cols })

export const ptyWrite = (terminalId: string, data: string) =>
  invoke<void>('pty_write', { terminalId, data })

export const ptyResize = (terminalId: string, rows: number, cols: number) =>
  invoke<void>('pty_resize', { terminalId, rows, cols })

export const ptyClose = (terminalId: string) =>
  invoke<void>('pty_close', { terminalId })

// Clipboard
export const readClipboard = () =>
  invoke<string>('read_clipboard')

// App lifecycle
export const quitApp = () =>
  invoke<void>('quit_app')
