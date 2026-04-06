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
