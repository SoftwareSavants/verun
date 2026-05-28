import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { CommitComposer } from './CommitComposer'

describe('<CommitComposer />', () => {
  test('Commit button disabled when worktree is fully clean', () => {
    cleanup()
    const { getByText } = render(() => (
      <CommitComposer
        taskId="t1"
        canCommit={false}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={() => Promise.resolve()}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    expect((getByText('Commit') as HTMLButtonElement).disabled).toBe(true)
  })

  test('Commit button enabled when canCommit is true and message is non-empty', async () => {
    cleanup()
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { getByText, getByPlaceholderText } = render(() => (
      <CommitComposer
        taskId="t1"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={onCommit}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta = getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: 'feat: thing' } })
    fireEvent.click(getByText('Commit'))
    expect(onCommit).toHaveBeenCalledWith('feat: thing')
  })

  test('draft message persists per task in localStorage', () => {
    cleanup()
    localStorage.removeItem('verun:changes:msg:t-A')
    const view1 = render(() => (
      <CommitComposer
        taskId="t-A"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={() => Promise.resolve()}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta = view1.getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: 'wip' } })
    expect(localStorage.getItem('verun:changes:msg:t-A')).toBe('wip')

    cleanup()
    const view2 = render(() => (
      <CommitComposer
        taskId="t-A"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={() => Promise.resolve()}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta2 = view2.getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    expect(ta2.value).toBe('wip')
  })

  test('Cmd+Enter submits when canCommit and message is non-empty', () => {
    cleanup()
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { getByPlaceholderText } = render(() => (
      <CommitComposer
        taskId="t-cmd"
        canCommit={true}
        canAmend={false}
        amendDefaultMessage=""
        onCommit={onCommit}
        onCommitAndPush={() => Promise.resolve()}
        onAmend={() => Promise.resolve()}
      />
    ))
    const ta = getByPlaceholderText(/commit message/i) as HTMLTextAreaElement
    fireEvent.input(ta, { target: { value: 'msg' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledWith('msg')
  })
})
