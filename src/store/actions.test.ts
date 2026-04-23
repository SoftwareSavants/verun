import { describe, test, expect, beforeEach, vi } from 'vitest'
import type { WorkflowRun, WorkflowJob } from '../types'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

const ipcMocks = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  listWorkflowJobs: vi.fn(),
  getWorkflowFailedLogs: vi.fn(),
  rerunWorkflowRun: vi.fn(),
  rerunWorkflowJob: vi.fn(),
  cancelWorkflowRun: vi.fn(),
}))

vi.mock('../lib/ipc', () => ipcMocks)

import {
  actionsState,
  refreshWorkflowRuns,
  isAnyRunActive,
  buildFixPrompt,
  clearActionsState,
  loadJobsForRun,
  loadJobLogs,
  markRunRerunning,
  rerunFailedJobsForRun,
  rerunSingleJob,
} from './actions'

function run(partial: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: 1,
    number: 1,
    workflowName: 'CI',
    state: 'success',
    url: 'https://x/y',
    createdAt: '2026-04-20T10:00:00Z',
    headSha: 'abc',
    headBranch: 'feat/x',
    event: 'push',
    ...partial,
  }
}

describe('actions store', () => {
  beforeEach(() => {
    clearActionsState('t1')
    ipcMocks.listWorkflowRuns.mockReset()
    ipcMocks.listWorkflowJobs.mockReset()
    ipcMocks.getWorkflowFailedLogs.mockReset()
    ipcMocks.rerunWorkflowRun.mockReset()
    ipcMocks.rerunWorkflowJob.mockReset()
    ipcMocks.cancelWorkflowRun.mockReset()
  })

  test('refreshWorkflowRuns populates state', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([
      run({ databaseId: 100, state: 'running' }),
      run({ databaseId: 99, state: 'success' }),
    ])

    await refreshWorkflowRuns('t1')

    expect(actionsState['t1']?.runs.length).toBe(2)
    expect(actionsState['t1']?.runs[0].databaseId).toBe(100)
    expect(actionsState['t1']?.lastRefresh).toBeGreaterThan(0)
  })

  test('refreshWorkflowRuns swallows ipc errors', async () => {
    ipcMocks.listWorkflowRuns.mockRejectedValue(new Error('gh missing'))

    await refreshWorkflowRuns('t1')

    expect(actionsState['t1']?.runs).toEqual([])
    expect(actionsState['t1']?.error).toContain('gh missing')
  })

  test('isAnyRunActive returns true when a run is queued or running', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([
      run({ databaseId: 1, state: 'success' }),
      run({ databaseId: 2, state: 'running' }),
    ])
    await refreshWorkflowRuns('t1')
    expect(isAnyRunActive('t1')).toBe(true)
  })

  test('isAnyRunActive returns false when all runs settled', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([
      run({ databaseId: 1, state: 'success' }),
      run({ databaseId: 2, state: 'failure' }),
    ])
    await refreshWorkflowRuns('t1')
    expect(isAnyRunActive('t1')).toBe(false)
  })

  test('loadJobsForRun caches jobs under the run', async () => {
    const jobs: WorkflowJob[] = [
      { databaseId: 10, name: 'test', state: 'failure', startedAt: null, completedAt: null, url: 'u' },
    ]
    ipcMocks.listWorkflowJobs.mockResolvedValue(jobs)

    await loadJobsForRun('t1', 42)

    expect(actionsState['t1']?.jobsByRun[42]).toEqual(jobs)
  })

  test('buildFixPrompt composes a structured summary (job, workflow, run, step, gh command)', async () => {
    ipcMocks.getWorkflowFailedLogs.mockResolvedValue([
      'Type Check\tRun build\t2026-04-22T10:00:01Z compiling',
      'Type Check\tRun build\t2026-04-22T10:00:02Z ##[error]boom',
    ].join('\n'))

    const prompt = await buildFixPrompt('t1', { runNumber: 42, workflowName: 'CI', runId: 999, jobId: 77, jobName: 'test' })

    expect(prompt).toContain('"test"')
    expect(prompt).toContain('CI')
    expect(prompt).toContain('#42')
    expect(prompt).toContain('Failing step: Run build')
    expect(prompt).toContain('gh run view --log-failed --job 77')
    expect(prompt).toContain('diagnose')
    // Full log should NOT be embedded — the agent fetches it on demand
    expect(prompt).not.toContain('compiling')
  })

  test('buildFixPrompt surfaces structured error annotations (file:line:col title msg)', async () => {
    ipcMocks.getWorkflowFailedLogs.mockResolvedValue([
      'Type Check\tRun build\t2026-04-22T10:00:01Z ##[error]file=src/foo.ts,line=17,col=3,title=TS2322::Type mismatch',
      'Type Check\tRun build\t2026-04-22T10:00:02Z ##[error]file=src/bar.ts,line=42::Another error',
      'Type Check\tRun build\t2026-04-22T10:00:03Z ##[error]boom without location',
    ].join('\n'))

    const prompt = await buildFixPrompt('t1', { runNumber: 1, workflowName: 'CI', runId: 1, jobId: 1, jobName: 'test' })

    expect(prompt).toMatch(/src\/foo\.ts:17:3/)
    expect(prompt).toContain('TS2322')
    expect(prompt).toContain('Type mismatch')
    expect(prompt).toMatch(/src\/bar\.ts:42/)
    expect(prompt).toContain('Another error')
    expect(prompt).toContain('boom without location')
  })

  test('buildFixPrompt reuses cached logs without hitting ipc', async () => {
    ipcMocks.getWorkflowFailedLogs.mockResolvedValue('Type Check\tRun build\t2026-04-22T10:00:01Z ##[error]cached boom')
    await loadJobLogs('t1', 999, 77)
    expect(ipcMocks.getWorkflowFailedLogs).toHaveBeenCalledTimes(1)

    ipcMocks.getWorkflowFailedLogs.mockClear()
    const prompt = await buildFixPrompt('t1', { runNumber: 42, workflowName: 'CI', runId: 999, jobId: 77, jobName: 'test' })

    expect(ipcMocks.getWorkflowFailedLogs).not.toHaveBeenCalled()
    expect(prompt).toContain('cached boom')
  })

  test('buildFixPrompt falls back to just the gh command when logs unavailable', async () => {
    ipcMocks.getWorkflowFailedLogs.mockRejectedValue(new Error('no perms'))

    const prompt = await buildFixPrompt('t1', { runNumber: 1, workflowName: 'CI', runId: 1, jobId: 55, jobName: 'test' })

    expect(prompt).toContain('"test"')
    expect(prompt).toContain('gh run view --log-failed --job 55')
  })

  test('clearActionsState removes the task entry', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([run()])
    await refreshWorkflowRuns('t1')
    expect(actionsState['t1']).toBeTruthy()

    clearActionsState('t1')
    expect(actionsState['t1']).toBeUndefined()
  })

  test('markRunRerunning flips run state to queued', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([
      run({ databaseId: 42, state: 'failure' }),
    ])
    await refreshWorkflowRuns('t1')
    expect(actionsState['t1']?.runs[0].state).toBe('failure')

    markRunRerunning('t1', 42)

    expect(actionsState['t1']?.runs[0].state).toBe('queued')
    expect(isAnyRunActive('t1')).toBe(true)
  })

  test('markRunRerunning marks cached jobs as queued', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([run({ databaseId: 42, state: 'failure' })])
    ipcMocks.listWorkflowJobs.mockResolvedValue([
      { databaseId: 1, name: 'test', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
      { databaseId: 2, name: 'lint', state: 'success', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
    ])
    await refreshWorkflowRuns('t1')
    await loadJobsForRun('t1', 42)

    markRunRerunning('t1', 42)

    const jobs = actionsState['t1']?.jobsByRun[42]
    expect(jobs?.every(j => j.state === 'queued')).toBe(true)
    // Reset timing so UI doesn't render stale durations
    expect(jobs?.every(j => j.startedAt === null && j.completedAt === null)).toBe(true)
  })

  test('rerunFailedJobsForRun calls ipc and optimistically updates state', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([run({ databaseId: 42, state: 'failure' })])
    ipcMocks.rerunWorkflowRun.mockResolvedValue(undefined)
    await refreshWorkflowRuns('t1')

    await rerunFailedJobsForRun('t1', 42)

    expect(ipcMocks.rerunWorkflowRun).toHaveBeenCalledWith('t1', 42, true)
    expect(actionsState['t1']?.runs[0].state).toBe('queued')
  })

  test('refreshWorkflowRuns does not clobber the optimistic queued state inside the rerun grace window', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValueOnce([run({ databaseId: 42, state: 'failure' })])
    await refreshWorkflowRuns('t1')
    markRunRerunning('t1', 42)
    expect(actionsState['t1']?.runs[0].state).toBe('queued')

    // GH still reports the old attempt as failure for a few seconds after rerun
    ipcMocks.listWorkflowRuns.mockResolvedValueOnce([run({ databaseId: 42, state: 'failure' })])
    await refreshWorkflowRuns('t1')

    expect(actionsState['t1']?.runs[0].state).toBe('queued')
  })

  test('refreshWorkflowRuns does not clobber optimistic queued jobs inside the rerun grace window', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValueOnce([run({ databaseId: 42, state: 'failure' })])
    ipcMocks.listWorkflowJobs.mockResolvedValueOnce([
      { databaseId: 1, name: 'test', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
    ])
    await refreshWorkflowRuns('t1')
    await loadJobsForRun('t1', 42)
    markRunRerunning('t1', 42)

    // Next poll: GH returns stale jobs list
    ipcMocks.listWorkflowJobs.mockResolvedValueOnce([
      { databaseId: 1, name: 'test', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
    ])
    await loadJobsForRun('t1', 42)

    expect(actionsState['t1']?.jobsByRun[42]?.[0].state).toBe('queued')
  })

  test('loadJobLogs caches logs keyed by jobId', async () => {
    ipcMocks.getWorkflowFailedLogs.mockResolvedValue('some log tail')
    await loadJobLogs('t1', 999, 55)

    expect(ipcMocks.getWorkflowFailedLogs).toHaveBeenCalledWith('t1', 999, 55)
    expect(actionsState['t1']?.logsByJob[55]?.text).toBe('some log tail')
    expect(actionsState['t1']?.logsByJob[55]?.loading).toBe(false)
    expect(actionsState['t1']?.logsByJob[55]?.error).toBeNull()
  })

  test('loadJobLogs dedupes concurrent calls', async () => {
    let resolveFn: (v: string) => void = () => {}
    ipcMocks.getWorkflowFailedLogs.mockReturnValue(new Promise<string>(r => { resolveFn = r }))

    const p1 = loadJobLogs('t1', 1, 10)
    const p2 = loadJobLogs('t1', 1, 10)

    expect(actionsState['t1']?.logsByJob[10]?.loading).toBe(true)
    resolveFn('logs here')
    await Promise.all([p1, p2])

    expect(ipcMocks.getWorkflowFailedLogs).toHaveBeenCalledTimes(1)
    expect(actionsState['t1']?.logsByJob[10]?.text).toBe('logs here')
  })

  test('loadJobLogs stores error on ipc failure', async () => {
    ipcMocks.getWorkflowFailedLogs.mockRejectedValue(new Error('no perms'))
    await loadJobLogs('t1', 1, 10)

    expect(actionsState['t1']?.logsByJob[10]?.error).toContain('no perms')
    expect(actionsState['t1']?.logsByJob[10]?.loading).toBe(false)
  })

  test('rerunSingleJob calls the job-level IPC and only flips the target job to queued', async () => {
    ipcMocks.listWorkflowRuns.mockResolvedValue([run({ databaseId: 42, state: 'failure' })])
    ipcMocks.listWorkflowJobs.mockResolvedValue([
      { databaseId: 10, name: 'test', state: 'failure', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
      { databaseId: 11, name: 'lint', state: 'success', startedAt: '2026-04-20T10:00:00Z', completedAt: '2026-04-20T10:01:00Z', url: 'u' },
    ])
    ipcMocks.rerunWorkflowJob.mockResolvedValue(undefined)

    await refreshWorkflowRuns('t1')
    await loadJobsForRun('t1', 42)
    await rerunSingleJob('t1', 42, 10)

    expect(ipcMocks.rerunWorkflowJob).toHaveBeenCalledWith('t1', 10)
    expect(ipcMocks.rerunWorkflowRun).not.toHaveBeenCalled()
    expect(actionsState['t1']?.runs[0].state).toBe('queued')
    const jobs = actionsState['t1']?.jobsByRun[42]
    expect(jobs?.find(j => j.databaseId === 10)?.state).toBe('queued')
    // Other (successful) jobs should NOT be marked queued — only the retried job
    expect(jobs?.find(j => j.databaseId === 11)?.state).toBe('success')
  })
})
