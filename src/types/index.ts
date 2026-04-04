export type AgentStatus = 'idle' | 'running' | 'paused' | 'done' | 'error'

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  repoPath: string
  worktreePath: string
  branch: string
  pid?: number
  prompt: string
  createdAt: number
  lastActiveAt: number
}

export interface Session {
  id: string
  agentId: string
  outputLines: string[]
  startedAt: number
  endedAt?: number
}

export interface Worktree {
  path: string
  branch: string
  agentId: string
}

export interface AgentOutputEvent {
  agentId: string
  lines: string[]
}

export interface AgentStatusEvent {
  agentId: string
  status: AgentStatus
}
