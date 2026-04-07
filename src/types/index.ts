export type SessionStatus = 'running' | 'idle' | 'done' | 'error'

export interface Project {
  id: string
  name: string
  repoPath: string
  createdAt: number
}

export interface Task {
  id: string
  projectId: string
  name: string | null
  worktreePath: string
  branch: string
  createdAt: number
}

export interface Session {
  id: string
  taskId: string
  name: string | null
  claudeSessionId: string | null
  status: SessionStatus
  startedAt: number
  endedAt: number | null
}

export interface OutputLine {
  id: number
  sessionId: string
  line: string
  emittedAt: number
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
  dataBase64: string
}

// Structured output items from Claude's stream-json protocol

export type OutputItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolStart'; tool: string; input: string }
  | { kind: 'toolResult'; text: string; isError: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'turnEnd'; status: string }
  | { kind: 'userMessage'; text: string; images?: Array<{ mimeType: string; dataBase64: string }> }
  | { kind: 'raw'; text: string }

export interface SessionOutputEvent {
  sessionId: string
  items: OutputItem[]
}

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
}

export interface ToolApprovalRequest {
  requestId: string
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
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
}

export interface CiCheck {
  name: string
  status: string
  url: string
}
