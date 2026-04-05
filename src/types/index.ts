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

export interface RepoInfo {
  root: string
  currentBranch: string
  branches: string[]
}

export interface SessionOutputEvent {
  sessionId: string
  lines: string[]
}

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
}
