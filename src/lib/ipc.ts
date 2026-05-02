import { invoke } from '@tauri-apps/api/core'
import type { Project, Task, TaskWithSession, Session, OutputLine, RepoInfo, AttachmentRef, AgentSkill, AgentInfo, AgentType, GitStatus, FileDiff, DiffContents, BranchCommit, GitHubRepo, PrInfo, CiCheck, WorkflowRun, WorkflowJob, ToolApprovalRequest, TrustLevel, AuditEntry, PtySpawnResult, PtyListEntry, FileEntry, Step, BlobRef, StorageStats, GitHubOverviewSnapshot, GitHubActionsSnapshot, WorkflowJobsSnapshot, WorkflowLogSnapshot, RemoteFetchMode, SideQuestionResponse } from '../types'

const DEMO = import.meta.env.VITE_DEMO_MODE === 'true'
const seed = () => import('./seedData')

// Projects
export const addProject = (repoPath: string) =>
  invoke<Project>('add_project', { repoPath })

export const listProjects = (): Promise<Project[]> =>
  DEMO ? seed().then(d => d.DEMO_PROJECTS) : invoke<Project[]>('list_projects')

export const deleteProject = (id: string) =>
  invoke<void>('delete_project', { id })

export const updateProjectBaseBranch = (id: string, baseBranch: string) =>
  invoke<void>('update_project_base_branch', { id, baseBranch })

export const updateProjectHooks = (id: string, setupHook: string, destroyHook: string, startCommand: string, autoStart: boolean) =>
  invoke<void>('update_project_hooks', { id, setupHook, destroyHook, startCommand, autoStart })

export const updateProjectDefaultAgent = (id: string, defaultAgentType: string) =>
  invoke<void>('update_project_default_agent', { id, defaultAgentType })

export const exportProjectConfig = (projectId: string, taskId?: string) =>
  invoke<void>('export_project_config', { projectId, taskId: taskId ?? null })

export const importProjectConfig = (projectId: string, taskId?: string) =>
  invoke<{ setupHook: string; destroyHook: string; startCommand: string }>('import_project_config', { projectId, taskId: taskId ?? null })

// Tasks
export const createTask = (projectId: string, baseBranch?: string, agentType?: AgentType) =>
  invoke<TaskWithSession>('create_task', { projectId, baseBranch, agentType })

export const listTasks = (projectId: string): Promise<Task[]> =>
  DEMO
    ? seed().then(d => d.DEMO_TASKS.filter(t => t.projectId === projectId))
    : invoke<Task[]>('list_tasks', { projectId })

export const getTask = (id: string) =>
  invoke<Task | null>('get_task', { id })

export const deleteTask = (id: string, deleteBranch: boolean, skipDestroyHook?: boolean) =>
  invoke<void>('delete_task', { id, deleteBranch, skipDestroyHook })

export const archiveTask = (id: string, skipDestroyHook?: boolean) =>
  invoke<void>('archive_task', { id, skipDestroyHook })

export const checkTaskWorktree = (id: string) =>
  invoke<[boolean, boolean]>('check_task_worktree', { id })

export const restoreTask = (id: string) =>
  invoke<void>('restore_task', { id })

export const renameTask = (taskId: string, name: string) =>
  invoke<void>('rename_task', { taskId, name })

export const getSetupInProgress = () =>
  invoke<string[]>('get_setup_in_progress')

export const runHook = (taskId: string, hookType: 'setup' | 'destroy') =>
  invoke<PtySpawnResult>('run_hook', { taskId, hookType })

export const stopHook = (taskId: string) =>
  invoke<void>('stop_hook', { taskId })

// Sessions
export const createSession = (taskId: string, agentType: string, model?: string) =>
  invoke<Session>('create_session', { taskId, agentType, model })

export const sendMessage = (sessionId: string, message: string, attachments?: AttachmentRef[], model?: string, planMode?: boolean, thinkingMode?: boolean, fastMode?: boolean) =>
  invoke<void>('send_message', { sessionId, message, attachments, model, planMode, thinkingMode, fastMode })

export const updateSessionModel = (sessionId: string, model: string | null) =>
  invoke<void>('update_session_model', { sessionId, model })

// Best-effort pre-warm: for persistent agents (Claude) this spawns the CLI in
// the background so the first user message doesn't pay the boot cost. No-op
// for non-persistent agents. Fire-and-forget — callers should swallow errors.
export const prewarmSession = (sessionId: string) =>
  invoke<void>('prewarm_session', { sessionId })

export const closeSession = (sessionId: string) =>
  invoke<void>('close_session', { sessionId })

export const clearSession = (sessionId: string) =>
  invoke<void>('clear_session', { sessionId })

export const abortMessage = (sessionId: string) =>
  invoke<void>('abort_message', { sessionId })

export const interruptSession = (sessionId: string) =>
  invoke<void>('interrupt_session', { sessionId })

export const getSessionContextUsage = (sessionId: string) =>
  invoke<unknown>('get_session_context_usage', { sessionId })

// Ephemeral side question (`/btw`). Resolves to `null` when the CLI cannot
// answer (e.g. on a freshly resumed session before the first turn completes).
export const askSideQuestion = (sessionId: string, question: string) =>
  invoke<SideQuestionResponse | null>('ask_side_question', { sessionId, question })

export const getActiveSessions = (): Promise<string[]> =>
  DEMO ? Promise.resolve([]) : invoke<string[]>('get_active_sessions')

export const respondToApproval = (requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, message?: string) =>
  invoke<void>('respond_to_approval', { requestId, behavior, updatedInput, message })

export const getPendingApprovals = (): Promise<ToolApprovalRequest[]> =>
  DEMO ? Promise.resolve([]) : invoke<ToolApprovalRequest[]>('get_pending_approvals')

export const listSessions = (taskId: string): Promise<Session[]> =>
  DEMO
    ? seed().then(d => d.DEMO_SESSIONS.filter(s => s.taskId === taskId))
    : invoke<Session[]>('list_sessions', { taskId })

export const listClosedSessions = (taskId: string): Promise<Session[]> =>
  DEMO ? Promise.resolve([]) : invoke<Session[]>('list_closed_sessions', { taskId })

export const reopenSession = (sessionId: string) =>
  invoke<Session>('reopen_session', { sessionId })

export const getSession = (id: string) =>
  invoke<Session | null>('get_session', { id })

export const forkSessionInTask = (sessionId: string, forkAfterMessageUuid: string) =>
  invoke<Session>('fork_session_in_task', { sessionId, forkAfterMessageUuid })

export const forkSessionToNewTask = (
  sessionId: string,
  forkAfterMessageUuid: string,
  worktreeState: 'snapshot' | 'current',
) =>
  invoke<TaskWithSession>('fork_session_to_new_task', {
    sessionId,
    forkAfterMessageUuid,
    worktreeState,
  })

export const getOutputLines = (
  sessionId: string,
  limit?: number,
  beforeId?: number,
): Promise<OutputLine[]> =>
  DEMO
    ? seed().then(d => {
        const all = d.DEMO_OUTPUT_LINES[sessionId] ?? []
        const upTo = beforeId != null ? all.filter(l => l.id < beforeId) : all
        return limit != null && limit >= 0 ? upTo.slice(-limit) : upTo
      })
    : invoke<OutputLine[]>('get_output_lines', { sessionId, limit, beforeId })

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

export const getBranchStatus = (taskId: string): Promise<[number, number, number]> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.branchStatus ?? [0, 0, 0])
    : invoke<[number, number, number]>('get_branch_status', { taskId })

export const getRepoInfo = (path: string) =>
  invoke<RepoInfo>('get_repo_info', { path })

// Git operations
export const getGitStatus = (taskId: string): Promise<GitStatus> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.status ?? { files: [], stats: [], totalInsertions: 0, totalDeletions: 0 })
    : invoke<GitStatus>('get_git_status', { taskId })

export const getFileDiff = (taskId: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_file_diff', { taskId, filePath, contextLines, ignoreWhitespace })

export const getFileContext = (taskId: string, filePath: string, startLine: number, endLine: number, version: 'old' | 'new') =>
  invoke<string[]>('get_file_context', { taskId, filePath, startLine, endLine, version })

export const getBranchCommits = (taskId: string): Promise<BranchCommit[]> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.commits ?? [])
    : invoke<BranchCommit[]>('get_branch_commits', { taskId })

export const getCommitFiles = (taskId: string, commitHash: string) =>
  invoke<GitStatus>('get_commit_files', { taskId, commitHash })

export const getCommitFileDiff = (taskId: string, commitHash: string, filePath: string, contextLines?: number, ignoreWhitespace?: boolean) =>
  invoke<FileDiff>('get_commit_file_diff', { taskId, commitHash, filePath, contextLines, ignoreWhitespace })

export const getFileDiffContents = (taskId: string, filePath: string) =>
  invoke<DiffContents>('get_file_diff_contents', { taskId, filePath })

export const getCommitFileContents = (taskId: string, commitHash: string, filePath: string) =>
  invoke<DiffContents>('get_commit_file_contents', { taskId, commitHash, filePath })

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
export const checkGithub = (taskId: string): Promise<GitHubRepo | null> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.github ?? null)
    : invoke<GitHubRepo | null>('check_github', { taskId })

export const createPullRequest = (taskId: string, title: string, body: string, base: string) =>
  invoke<PrInfo>('create_pull_request', { taskId, title, body, base })

export const getPullRequest = (taskId: string): Promise<PrInfo | null> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.pr ?? null)
    : invoke<PrInfo | null>('get_pull_request', { taskId })

export const markPrReady = (taskId: string) =>
  invoke<void>('mark_pr_ready', { taskId })

export const mergePullRequest = (taskId: string, force?: boolean, deleteBranch?: boolean) =>
  invoke<void>('merge_pull_request', { taskId, force, deleteBranch })

export const gitShip = (taskId: string, commitMessage: string, prTitle: string, prBody: string, base: string) =>
  invoke<PrInfo>('git_ship', { taskId, commitMessage, prTitle, prBody, base })

export const getCiChecks = (taskId: string): Promise<CiCheck[]> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.checks ?? [])
    : invoke<CiCheck[]>('get_ci_checks', { taskId })

export const getBranchUrl = (taskId: string): Promise<string | null> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.branchUrl ?? null)
    : invoke<string | null>('get_branch_url', { taskId })

export const hasConflicts = (taskId: string): Promise<boolean> =>
  DEMO
    ? seed().then(d => d.DEMO_GIT_DATA[taskId]?.pr?.mergeable === 'CONFLICTING')
    : invoke<boolean>('has_conflicts', { taskId })

export const getGithubOverview = (taskId: string, mode?: RemoteFetchMode): Promise<GitHubOverviewSnapshot> =>
  DEMO
    ? seed().then(d => ({
      github: d.DEMO_GIT_DATA[taskId]?.github ?? null,
      branchUrl: d.DEMO_GIT_DATA[taskId]?.branchUrl ?? null,
      pr: d.DEMO_GIT_DATA[taskId]?.pr ?? null,
      checks: d.DEMO_GIT_DATA[taskId]?.checks ?? [],
      fetchedAt: Date.now(),
      staleAt: Date.now() + 30_000,
      expiresAt: Date.now() + 300_000,
      isStale: false,
      fromCache: false,
    }))
    : invoke<GitHubOverviewSnapshot>('get_github_overview', { taskId, mode })

// GitHub Actions
export const listWorkflowRuns = (taskId: string, limit?: number): Promise<WorkflowRun[]> =>
  DEMO ? Promise.resolve([]) : invoke<WorkflowRun[]>('list_workflow_runs', { taskId, limit })

export const listWorkflowJobs = (taskId: string, runId: number): Promise<WorkflowJob[]> =>
  DEMO ? Promise.resolve([]) : invoke<WorkflowJob[]>('list_workflow_jobs', { taskId, runId })

export const getWorkflowFailedLogs = (taskId: string, runId: number, jobId: number, maxBytes?: number): Promise<string> =>
  invoke<string>('get_workflow_failed_logs', { taskId, runId, jobId, maxBytes })

export const rerunWorkflowRun = (taskId: string, runId: number, failedOnly?: boolean): Promise<void> =>
  invoke<void>('rerun_workflow_run', { taskId, runId, failedOnly })

export const rerunWorkflowJob = (taskId: string, jobId: number): Promise<void> =>
  invoke<void>('rerun_workflow_job', { taskId, jobId })

export const cancelWorkflowRun = (taskId: string, runId: number): Promise<void> =>
  invoke<void>('cancel_workflow_run', { taskId, runId })

export const getGithubActions = (taskId: string, limit?: number, mode?: RemoteFetchMode): Promise<GitHubActionsSnapshot> =>
  DEMO
    ? Promise.resolve({
      runs: [],
      fetchedAt: Date.now(),
      staleAt: Date.now() + 10_000,
      expiresAt: Date.now() + 300_000,
      isStale: false,
      fromCache: false,
    })
    : invoke<GitHubActionsSnapshot>('get_github_actions', { taskId, limit, mode })

export const getGithubWorkflowJobs = (taskId: string, runId: number, mode?: RemoteFetchMode): Promise<WorkflowJobsSnapshot> =>
  DEMO
    ? Promise.resolve({
      runId,
      jobs: [],
      fetchedAt: Date.now(),
      staleAt: Date.now() + 10_000,
      expiresAt: Date.now() + 300_000,
      isStale: false,
      fromCache: false,
    })
    : invoke<WorkflowJobsSnapshot>('get_github_workflow_jobs', { taskId, runId, mode })

export const getGithubWorkflowLog = (taskId: string, jobId: number, maxBytes?: number, mode?: RemoteFetchMode): Promise<WorkflowLogSnapshot> =>
  DEMO
    ? Promise.resolve({
      jobId,
      text: '',
      fetchedAt: Date.now(),
      staleAt: Date.now() + 10_000,
      expiresAt: Date.now() + 300_000,
      isStale: false,
      fromCache: false,
    })
    : invoke<WorkflowLogSnapshot>('get_github_workflow_log', { taskId, jobId, maxBytes, mode })

// File listing
export const listWorktreeFiles = (taskId: string) =>
  invoke<string[]>('list_worktree_files', { taskId })

// Workspace content search (Cmd+Shift+F)
export interface WorkspaceSearchOpts {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  includes?: string[]
  excludes?: string[]
}

export const workspaceSearchStart = (taskId: string, query: string, opts?: WorkspaceSearchOpts) =>
  invoke<void>('workspace_search_start', { taskId, query, opts })

export const workspaceSearchCancel = (taskId: string) =>
  invoke<void>('workspace_search_cancel', { taskId })

export const checkGitignored = (taskId: string, paths: string[]) =>
  invoke<string[]>('check_gitignored', { taskId, paths })

// Utility
export const listAgentSkills = (agentKind: AgentType, scanRoot?: string) =>
  invoke<AgentSkill[]>('list_agent_skills', {
    agentKind,
    scanRoot: scanRoot ?? null,
  })

export const checkAgent = (agentType: AgentType) =>
  invoke<string>('check_agent', { agentType })

export const listAvailableAgents = () =>
  invoke<AgentInfo[]>('list_available_agents')

export const refreshAgents = () =>
  invoke<void>('refresh_agents')

export const reloadEnvPath = () =>
  invoke<void>('reload_env_path')

export const openInFinder = (path: string) =>
  invoke<void>('open_in_finder', { path })

export const openInApp = (path: string, app: string) =>
  invoke<void>('open_in_app', { path, app })

// PTY / Terminal
export const ptySpawn = (taskId: string, rows: number, cols: number, initialCommand?: string, directCommand?: boolean, isStartCommand?: boolean) =>
  invoke<PtySpawnResult>('pty_spawn', { taskId, rows, cols, initialCommand, directCommand, isStartCommand })

export const ptyListForTask = (taskId: string) =>
  invoke<PtyListEntry[]>('pty_list_for_task', { taskId })

export const ptyWrite = (terminalId: string, data: string) =>
  invoke<void>('pty_write', { terminalId, data })

export const ptyResize = (terminalId: string, rows: number, cols: number) =>
  invoke<void>('pty_resize', { terminalId, rows, cols })

export const ptyClose = (terminalId: string) =>
  invoke<void>('pty_close', { terminalId })

// Claude terminal mode (PTY running `claude --resume`)
export interface OpenClaudeTerminalResult {
  terminalId: string
  sessionId: string
}
export const claudeTerminalOpen = (sessionId: string, rows: number, cols: number) =>
  invoke<OpenClaudeTerminalResult>('claude_terminal_open', { sessionId, rows, cols })

export const claudeTerminalClose = (sessionId: string) =>
  invoke<void>('claude_terminal_close', { sessionId })

// Clipboard
export const readClipboard = () =>
  invoke<string>('read_clipboard')

export const copyImageToClipboard = (mimeType: string, data: Uint8Array) =>
  invoke<void>('copy_image_to_clipboard', data.buffer as ArrayBuffer, {
    headers: { 'mime-type': mimeType },
  })

export const writeBinaryFile = (path: string, data: Uint8Array) =>
  invoke<void>('write_binary_file', data.buffer as ArrayBuffer, {
    headers: { path },
  })

export const readTextFile = (path: string) =>
  invoke<string>('read_text_file', { path })

// File tree
export const listDirectory = (taskId: string, relativePath: string) =>
  invoke<FileEntry[]>('list_directory', { taskId, relativePath })

export const readWorktreeFile = (taskId: string, relativePath: string, maxBytes?: number) =>
  invoke<string>('read_worktree_file', { taskId, relativePath, maxBytes })

export const resolveWorktreeFilePath = (taskId: string, relativePath: string) =>
  invoke<string>('resolve_worktree_file_path', { taskId, relativePath })

export const writeTextFile = (taskId: string, relativePath: string, content: string) =>
  invoke<void>('write_text_file', { taskId, relativePath, content })

export const watchWorktree = (taskId: string) =>
  invoke<void>('watch_worktree', { taskId })

export const unwatchWorktree = (taskId: string) =>
  invoke<void>('unwatch_worktree', { taskId })

// LSP
export const lspStart = (taskId: string, worktreePath: string) =>
  invoke<void>('lsp_start', { taskId, worktreePath })

export const lspSend = (taskId: string, message: string) =>
  invoke<void>('lsp_send', { taskId, message })

export const lspStop = (taskId: string) =>
  invoke<void>('lsp_stop', { taskId })

export const tsgoCheckRun = (taskId: string, worktreePath: string) =>
  invoke<void>('tsgo_check_run', { taskId, worktreePath })

export const tsgoCheckCancel = (taskId: string) =>
  invoke<void>('tsgo_check_cancel', { taskId })

// Steps
export const listSteps = (sessionId: string): Promise<Step[]> =>
  DEMO ? Promise.resolve([]) : invoke<Step[]>('list_steps', { sessionId })

export const addStep = (id: string, sessionId: string, message: string, attachmentsJson: string | null, armed: boolean, model: string | null, planMode: boolean | null, thinkingMode: boolean | null, fastMode: boolean | null, sortOrder: number) =>
  invoke<void>('add_step', { id, sessionId, message, attachmentsJson, armed, model, planMode, thinkingMode, fastMode, sortOrder })

export const updateStep = (id: string, message: string, armed: boolean, model: string | null, planMode: boolean | null, thinkingMode: boolean | null, fastMode: boolean | null, attachmentsJson: string | null) =>
  invoke<void>('update_step', { id, message, armed, model, planMode, thinkingMode, fastMode, attachmentsJson })

export const deleteStep = (id: string) =>
  invoke<void>('delete_step', { id })

export const reorderSteps = (sessionId: string, ids: string[]) =>
  invoke<void>('reorder_steps', { sessionId, ids })

export const disarmAllSteps = (sessionId: string) =>
  invoke<void>('disarm_all_steps', { sessionId })

// Better-T-Stack scaffolding
export const scaffoldBetterTStack = (
  parentDir: string,
  projectName: string,
  pmRunner: string,
  cliArgs: string[],
  verunConfig: Record<string, unknown>,
  scaffoldId: string,
) =>
  invoke<string>('scaffold_better_t_stack', {
    parentDir,
    projectName,
    pmRunner,
    cliArgs,
    verunConfig,
    scaffoldId,
  })

export const killBtsScaffold = (scaffoldId: string) =>
  invoke<void>('kill_bts_scaffold', { scaffoldId })

export const btsScaffoldInput = (scaffoldId: string, data: string) =>
  invoke<void>('bts_scaffold_input', { scaffoldId, data })

export const btsScaffoldResize = (scaffoldId: string, rows: number, cols: number) =>
  invoke<void>('bts_scaffold_resize', { scaffoldId, rows, cols })

export const listSubdirs = (path: string) =>
  invoke<string[]>('list_subdirs', { path })

export const createSubdir = (parent: string, name: string) =>
  invoke<string>('create_subdir', { parent, name })

export const defaultBootstrapDir = () =>
  invoke<string>('default_bootstrap_dir')

// App lifecycle
export const quitApp = () =>
  invoke<void>('quit_app')

// Window management
export const openTaskWindow = (taskId: string, taskName?: string) =>
  invoke<void>('open_task_window', { taskId, taskName })

export const openNewTaskWindow = (projectId: string) =>
  invoke<void>('open_new_task_window', { projectId })

export const forceCloseTaskWindow = () =>
  invoke<void>('force_close_task_window')

// Blob store (attachments) — bytes ride the IPC wire as Uint8Array directly,
// no base64. Tauri v2 serializes Vec<u8> from/to ArrayBuffer-style payloads.
export const uploadAttachment = (mime: string, data: Uint8Array): Promise<BlobRef> =>
  invoke<BlobRef>('upload_attachment', { mime, data })

export const getBlob = (hash: string): Promise<Uint8Array> =>
  invoke<number[] | Uint8Array>('get_blob', { hash })
    .then(b => b instanceof Uint8Array ? b : new Uint8Array(b))

export const getStorageStats = (): Promise<StorageStats> =>
  invoke<StorageStats>('get_storage_stats')

export interface GcReport {
  reclaimedUnreferenced: number
  reclaimedCapped: number
}

export const runBlobGc = (ttlMs: number, maxBytes: number): Promise<GcReport> =>
  invoke<GcReport>('run_blob_gc', { ttlMs, maxBytes })

export interface MigrationReport {
  stepsMigrated: number
  outputLinesMigrated: number
  blobsCreated: number
  alreadyDone: boolean
}

export const migrateLegacyAttachments = (): Promise<MigrationReport> =>
  invoke<MigrationReport>('migrate_legacy_attachments')
