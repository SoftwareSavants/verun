import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import type { Task, Project } from '../types'

// PinBranchDialog (#61) — lets a user attach a worktree to an existing local
// branch (trunk/develop), creating a pinned task that lives above regular
// tasks in the sidebar.

const { listLocalBranchesMock, pinBranchMock, projectByIdMock } = vi.hoisted(() => ({
  listLocalBranchesMock: vi.fn(() => Promise.resolve(['trunk', 'develop', 'main'])),
  pinBranchMock: vi.fn(),
  projectByIdMock: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  listLocalBranches: listLocalBranchesMock,
  pinBranch: pinBranchMock,
}))

vi.mock('../store/projects', () => ({
  projectById: projectByIdMock,
}))

import { PinBranchDialog } from './PinBranchDialog'

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'repo',
  repoPath: '/tmp/repo',
  baseBranch: 'main',
  setupHook: '',
  destroyHook: '',
  startCommand: '',
  autoStart: false,
  createdAt: 0,
  defaultAgentType: 'claude',
  ...overrides,
})

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'pinned-1',
  projectId: 'p1',
  name: null,
  worktreePath: '/tmp/p1/.verun/worktrees/trunk',
  branch: 'trunk',
  createdAt: 1,
  mergeBaseSha: null,
  portOffset: 1,
  archived: false,
  archivedAt: null,
  lastCommitMessage: null,
  parentTaskId: null,
  agentType: 'claude',
  isPinned: true,
  ...overrides,
})

async function flushMicrotasks(n = 4) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('PinBranchDialog', () => {
  beforeEach(() => {
    listLocalBranchesMock.mockReset()
    listLocalBranchesMock.mockResolvedValue(['trunk', 'develop', 'main'])
    pinBranchMock.mockReset()
    pinBranchMock.mockResolvedValue(makeTask())
    projectByIdMock.mockReset()
    projectByIdMock.mockReturnValue(makeProject())
    cleanup()
  })

  test('loads local branches on open', async () => {
    render(() => <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()
    expect(listLocalBranchesMock).toHaveBeenCalledWith('p1')
  })

  test('does not load branches when closed', async () => {
    render(() => <PinBranchDialog open={false} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()
    expect(listLocalBranchesMock).not.toHaveBeenCalled()
  })

  test('calls pinBranch with the selected branch on submit', async () => {
    const onClose = vi.fn()
    const { getByRole } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={onClose} />)
    await flushMicrotasks()

    const select = getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'develop' } })

    fireEvent.click(getByRole('button', { name: 'Pin Branch' }))
    await flushMicrotasks()

    expect(pinBranchMock).toHaveBeenCalledWith('p1', 'develop')
  })

  test('closes after successful pin', async () => {
    const onClose = vi.fn()
    const { getByRole } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={onClose} />)
    await flushMicrotasks()

    fireEvent.click(getByRole('button', { name: 'Pin Branch' }))
    await flushMicrotasks()

    expect(onClose).toHaveBeenCalled()
  })

  test('shows error and stays open when pinBranch rejects', async () => {
    pinBranchMock.mockRejectedValue('worktree already exists')
    const onClose = vi.fn()
    const { getByRole, findByText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={onClose} />)
    await flushMicrotasks()

    fireEvent.click(getByRole('button', { name: 'Pin Branch' }))
    await flushMicrotasks()

    expect(await findByText(/worktree already exists/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('shows list error when listLocalBranches rejects', async () => {
    listLocalBranchesMock.mockRejectedValue('git not installed')
    const { findByText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    expect(await findByText(/git not installed/)).toBeTruthy()
  })

  test('shows empty-state copy when every branch is already pinned', async () => {
    listLocalBranchesMock.mockResolvedValue([])
    const { findByText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    expect(await findByText(/Every local branch is already pinned/)).toBeTruthy()
  })

  test('disables Pin Branch button when no branches are available', async () => {
    listLocalBranchesMock.mockResolvedValue([])
    const { getByRole } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    const btn = getByRole('button', { name: 'Pin Branch' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  test('shows filter input when there are more than 6 branches', async () => {
    listLocalBranchesMock.mockResolvedValue([
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta',
    ])
    const { findByPlaceholderText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    expect(await findByPlaceholderText('Filter branches…')).toBeTruthy()
  })

  test('filter narrows the select options and selects first match', async () => {
    listLocalBranchesMock.mockResolvedValue([
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta',
    ])
    const { findByPlaceholderText, getByRole } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    const filter = await findByPlaceholderText('Filter branches…') as HTMLInputElement
    fireEvent.input(filter, { target: { value: 'eta' } })
    await flushMicrotasks()

    const select = getByRole('combobox') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((o) => o.value)
    // beta, zeta, eta all contain "eta" as a substring
    expect(optionValues).toEqual(['beta', 'zeta', 'eta'])
    expect(select.value).toBe('beta')
  })

  test('shows a worktree path preview under the selection', async () => {
    projectByIdMock.mockReturnValue(makeProject({ repoPath: '/Users/me/code/verun' }))
    const { findByText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    expect(
      await findByText('/Users/me/code/verun/.verun/worktrees/trunk'),
    ).toBeTruthy()
  })

  test('shows count when every branch matches the filter', async () => {
    listLocalBranchesMock.mockResolvedValue(['alpha', 'beta', 'gamma'])
    const { findByText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    expect(await findByText('3 branches available')).toBeTruthy()
  })

  test('pluralizes count correctly when exactly one branch is available', async () => {
    listLocalBranchesMock.mockResolvedValue(['trunk'])
    const { findByText } = render(() =>
      <PinBranchDialog open={true} projectId="p1" onClose={() => {}} />)
    await flushMicrotasks()

    expect(await findByText('1 branch available')).toBeTruthy()
  })

  test('re-fetches branches when the dialog reopens for a different project', async () => {
    listLocalBranchesMock.mockResolvedValue(['trunk'])
    const [projectId, setProjectId] = createSignal<string | null>('p1')
    render(() => <PinBranchDialog open={true} projectId={projectId()} onClose={() => {}} />)
    await flushMicrotasks()

    listLocalBranchesMock.mockResolvedValue(['release'])
    setProjectId('p2')
    await flushMicrotasks()

    expect(listLocalBranchesMock).toHaveBeenCalledTimes(2)
    expect(listLocalBranchesMock).toHaveBeenLastCalledWith('p2')
  })
})
