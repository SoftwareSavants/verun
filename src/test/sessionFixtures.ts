import type { Session } from '../types'

// Sessions as the tests of the components need them: the same shape the backend sends.

/** An idle Claude session `s1` of task `t1`, on the Default account, unless a test says otherwise. */
export const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 's1',
  taskId: 't1',
  name: null,
  resumeSessionId: null,
  status: 'idle',
  startedAt: 0,
  endedAt: null,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  parentSessionId: null,
  forkedAtMessageUuid: null,
  agentType: 'claude',
  model: null,
  closedAt: null,
  accountId: null,
  ...overrides,
})
