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
}

export interface Session {
  id: string
  taskId: string
  name: string | null
  claudeSessionId: string | null
  status: SessionStatus
  startedAt: number
  endedAt: number | null
  totalCost: number
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

export type ModelId = 'opus' | 'sonnet' | 'haiku'

export const MODEL_OPTIONS: { id: ModelId; label: string; description: string }[] = [
  { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
  { id: 'opus', label: 'Opus', description: 'Most capable' },
  { id: 'haiku', label: 'Haiku', description: 'Fastest' },
]

export interface ClaudeSkill {
  name: string
  description: string
}

export interface Attachment {
  name: string
  mimeType: string
  data: Uint8Array
}

// Structured output items from Claude's stream-json protocol

export type OutputItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolStart'; tool: string; input: string }
  | { kind: 'toolResult'; text: string; isError: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'turnEnd'; status: string; timestamp?: number; cost?: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'userMessage'; text: string; images?: Array<{ mimeType: string; data: Uint8Array }>; timestamp?: number }
  | { kind: 'raw'; text: string }

export interface SessionOutputEvent {
  sessionId: string
  items: OutputItem[]
}

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
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
  mergeable: string
  isDraft: boolean
}

export interface CiCheck {
  name: string
  status: string
  url: string
}

// Terminal / PTY types

export interface TerminalInstance {
  id: string
  taskId: string
  name: string
  hookType?: 'setup' | 'destroy'
  isStartCommand?: boolean
}

export interface PtySpawnResult {
  terminalId: string
  shellName: string
}

export interface PtyOutputEvent {
  terminalId: string
  data: string
}

export interface PtyExitedEvent {
  terminalId: string
  exitCode?: number
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
