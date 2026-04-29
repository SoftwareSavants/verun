export type SessionStatus = 'running' | 'idle' | 'done' | 'error'

export interface Project {
  id: string
  name: string
  repoPath: string
  baseBranch: string
  setupHook: string
  destroyHook: string
  startCommand: string
  autoStart: boolean
  createdAt: number
  defaultAgentType: AgentType
}

export type AgentType = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode'

export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
}

export interface Task {
  id: string
  projectId: string
  name: string | null
  worktreePath: string
  branch: string
  createdAt: number
  mergeBaseSha: string | null
  portOffset: number
  archived: boolean
  archivedAt: number | null
  lastCommitMessage: string | null
  parentTaskId: string | null
  agentType: AgentType // legacy DB column, not used - agent lives on sessions
}

export interface Session {
  id: string
  taskId: string
  name: string | null
  resumeSessionId: string | null
  status: SessionStatus
  error?: string
  startedAt: number
  endedAt: number | null
  totalCost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  parentSessionId: string | null
  forkedAtMessageUuid: string | null
  agentType: AgentType
  model: string | null
  closedAt: number | null
}

export interface OutputLine {
  id: number
  sessionId: string
  line: string
  emittedAt: number
}

export interface Step {
  id: string
  sessionId: string
  message: string
  attachmentsJson: string | null
  armed: boolean
  model: string | null
  planMode: boolean | null
  thinkingMode: boolean | null
  fastMode: boolean | null
  sortOrder: number
  createdAt: number
}

export interface TaskWithSession {
  task: Task
  session: Session
}

export interface RepoInfo {
  root: string
  currentBranch: string
  branches: string[]
}

export type ModelId = string

export interface ModelOption {
  id: string
  label: string
  description: string
  minVersion?: string
}

export interface AgentSkill {
  name: string
  description: string
}

export interface AgentInfo {
  id: AgentType
  name: string
  installHint: string
  updateHint: string
  docsUrl: string
  models: ModelOption[]
  installed: boolean
  cliVersion?: string
  supportsStreaming: boolean
  supportsResume: boolean
  supportsPlanMode: boolean
  supportsModelSelection: boolean
  supportsEffort: boolean
  supportsSkills: boolean
  supportsAttachments: boolean
  supportsFork: boolean
}

/**
 * In-memory attachment held briefly by the composer between paste/drop and
 * upload. Once `uploadAttachment` returns, the bytes are dropped and the
 * composer holds the resulting `AttachmentRef` instead.
 */
export interface Attachment {
  name: string
  mimeType: string
  data: Uint8Array
}

/**
 * Reference to a blob in the content-addressed store. This is the persistent
 * shape used in Step.attachmentsJson and OutputItem.userMessage.images;
 * bytes are fetched lazily via `getBlob(hash)` only when rendered.
 */
export interface AttachmentRef {
  hash: string
  mimeType: string
  name: string
  size: number
}

/**
 * Raw blob handle returned by the upload command. `AttachmentRef` is just
 * `BlobRef` with a user-facing filename glued on.
 */
export interface BlobRef {
  hash: string
  mime: string
  size: number
}

export interface StorageStats {
  totalBytes: number
  referencedBytes: number
  unreferencedBytes: number
  blobCount: number
  referencedCount: number
  unreferencedCount: number
}

// Structured output items from Claude's stream-json protocol

export interface PlanStep {
  status: string
  step: string
}

export type OutputItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolStart'; tool: string; input: string }
  | { kind: 'toolResult'; text: string; isError: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'errorMessage'; message: string; raw?: string }
  | { kind: 'turnEnd'; status: string; timestamp?: number; cost?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; error?: string }
  | { kind: 'turnSnapshot'; messageUuid: string }
  | { kind: 'userMessage'; text: string; images?: AttachmentRef[]; timestamp?: number }
  | { kind: 'planUpdate'; items: PlanStep[]; explanation?: string }
  | { kind: 'diffUpdate'; diff: string }
  | { kind: 'codexPlanDelta'; itemId: string; delta: string }
  | { kind: 'codexPlanReady'; itemId: string; text: string; filePath?: string }
  | { kind: 'raw'; text: string }

export interface SessionOutputEvent {
  sessionId: string
  items: OutputItem[]
}

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
  error?: string
}

export interface RateLimitInfo {
  sessionId: string
  resetsAt: number
  overageResetsAt: number
  rateLimitType: string
  overageStatus: string
  isUsingOverage: boolean
}

export interface ToolApprovalRequest {
  requestId: string
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
}

// Policy types

export type TrustLevel = 'normal' | 'full_auto' | 'supervised'

export interface AuditEntry {
  id: number
  sessionId: string
  taskId: string
  toolName: string
  toolInputSummary: string
  decision: string
  reason: string
  createdAt: number
}

export interface PolicyAutoApprovedEvent {
  sessionId: string
  toolName: string
  toolInputSummary: string
  decision: string
  reason: string
}

// Git types

export interface FileStatus {
  path: string
  status: string
  staging: string
  oldPath?: string
}

export interface FileDiffStats {
  path: string
  insertions: number
  deletions: number
}

export interface GitStatus {
  files: FileStatus[]
  stats: FileDiffStats[]
  totalInsertions: number
  totalDeletions: number
}

export interface DiffLine {
  kind: string
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  status: string
  hunks: DiffHunk[]
  stats: FileDiffStats
  totalLines: number
}

export interface DiffContents {
  path: string
  status: string
  oldText: string
  newText: string
  binary: boolean
}

export interface BranchCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  timestamp: number
  filesChanged: number
  insertions: number
  deletions: number
}

export interface GitHubRepo {
  owner: string
  name: string
  url: string
}

export interface PrInfo {
  number: number
  url: string
  state: string
  title: string
  body?: string
  mergeable: string
  isDraft: boolean
}

export interface CiCheck {
  name: string
  status: string
  url: string
}

export interface GitHubOverviewSnapshot {
  github: GitHubRepo | null
  branchUrl: string | null
  pr: PrInfo | null
  checks: CiCheck[]
  fetchedAt: number
  staleAt: number
  expiresAt: number
  isStale: boolean
  fromCache: boolean
}

export type WorkflowRunState = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped'

export interface WorkflowRun {
  databaseId: number
  number: number
  workflowName: string
  state: WorkflowRunState
  url: string
  createdAt: string
  headSha: string
  headBranch: string
  event: string
}

export interface WorkflowJob {
  databaseId: number
  name: string
  state: WorkflowRunState
  startedAt: string | null
  completedAt: string | null
  url: string
}

export interface GitHubActionsSnapshot {
  runs: WorkflowRun[]
  fetchedAt: number
  staleAt: number
  expiresAt: number
  isStale: boolean
  fromCache: boolean
}

export interface WorkflowJobsSnapshot {
  runId: number
  jobs: WorkflowJob[]
  fetchedAt: number
  staleAt: number
  expiresAt: number
  isStale: boolean
  fromCache: boolean
}

export interface WorkflowLogSnapshot {
  jobId: number
  text: string
  fetchedAt: number
  staleAt: number
  expiresAt: number
  isStale: boolean
  fromCache: boolean
}

export type RemoteFetchMode = 'cache-first' | 'stale-while-revalidate' | 'network-only'

export interface GitHubDebugEvent {
  taskId: string
  scope: string
  stage: string
  mode?: RemoteFetchMode | 'event'
  cacheState?: 'miss' | 'fresh' | 'stale'
  fromCache?: boolean
  durationMs?: number
  detail?: string
  emittedAt: number
}

// Terminal / PTY types

export interface TerminalInstance {
  id: string
  taskId: string
  name: string
  hookType?: 'setup' | 'destroy'
  isStartCommand?: boolean
  /** Scrollback to replay into xterm on first mount (from Rust ring buffer).
   *  Consumed and cleared by ShellTerminal. */
  initialReplay?: { data: string; seq: number }
}

export interface PtySpawnResult {
  terminalId: string
  shellName: string
}

export interface PtyOutputEvent {
  terminalId: string
  data: string
  /** Total bytes written to the PTY including this chunk. Used to dedupe live
   *  events against the snapshot returned by pty_list_for_task. */
  seq: number
}

export interface PtyExitedEvent {
  terminalId: string
  exitCode?: number
}

export interface PtyListEntry {
  terminalId: string
  taskId: string
  name: string
  isStartCommand: boolean
  hookType?: string | null
  bufferedOutput: string
  seq: number
}

// File tree types

export interface FileEntry {
  name: string
  relativePath: string
  isDir: boolean
  isSymlink: boolean
  size: number | null
}

export interface FileTreeChangedEvent {
  taskId: string
  path: string
}

// Diagnostics / Problems

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface Problem {
  file: string           // relative path within worktree
  line: number           // 1-based for display
  column: number         // 1-based for display
  endLine: number
  endColumn: number
  severity: DiagnosticSeverity
  message: string
  code?: string | number
  source: string         // 'typescript', 'eslint', etc.
}
