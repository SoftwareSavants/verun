import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { FileRow } from './FileRow'
import type { FileEntry } from '../lib/gitStatus'

const entry = (over: Partial<FileEntry['file']> = {}, kind: FileEntry['kind'] = 'unstaged'): FileEntry => ({
  kind,
  file: {
    path: 'src/foo.ts',
    indexStatus: ' ',
    worktreeStatus: 'M',
    conflict: null,
    ...over,
  },
} as FileEntry)

describe('<FileRow />', () => {
  test('renders status letter from badge', () => {
    cleanup()
    const { container } = render(() => (
      <FileRow
        entry={entry()}
        active={false}
        onOpenDiff={() => {}}
        onOpenFile={() => {}}
        onPrimary={() => {}}
        onDiscard={() => {}}
      />
    ))
    expect(container.textContent).toContain('M')
  })

  test('clicking the discard button fires onDiscard immediately (confirmation lives in a dialog upstream)', () => {
    cleanup()
    const onDiscard = vi.fn()
    const { getByTitle } = render(() => (
      <FileRow
        entry={entry()}
        active={false}
        onOpenDiff={() => {}}
        onOpenFile={() => {}}
        onPrimary={() => {}}
        onDiscard={onDiscard}
      />
    ))
    fireEvent.click(getByTitle('Discard'))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  test('clicking the row calls onOpenDiff', () => {
    cleanup()
    const onOpenDiff = vi.fn()
    const { container } = render(() => (
      <FileRow
        entry={entry()}
        active={false}
        onOpenDiff={onOpenDiff}
        onOpenFile={() => {}}
        onPrimary={() => {}}
        onDiscard={() => {}}
      />
    ))
    fireEvent.click(container.querySelector('[data-testid=file-row]')!)
    expect(onOpenDiff).toHaveBeenCalledTimes(1)
  })

  test('staged kind shows minus button, unstaged shows plus', () => {
    cleanup()
    const stagedView = render(() => (
      <FileRow entry={entry({ indexStatus: 'M' }, 'staged')} active={false}
        onOpenDiff={() => {}} onOpenFile={() => {}} onPrimary={() => {}} onDiscard={() => {}} />
    ))
    expect(stagedView.queryByTitle('Unstage')).toBeTruthy()

    cleanup()
    const unstagedView = render(() => (
      <FileRow entry={entry()} active={false}
        onOpenDiff={() => {}} onOpenFile={() => {}} onPrimary={() => {}} onDiscard={() => {}} />
    ))
    expect(unstagedView.queryByTitle('Stage')).toBeTruthy()
  })

  test('conflict kind shows ! letter and stage button (not discard)', () => {
    cleanup()
    const view = render(() => (
      <FileRow entry={entry({ indexStatus: 'U', worktreeStatus: 'U', conflict: 'bothModified' }, 'conflict')} active={false}
        onOpenDiff={() => {}} onOpenFile={() => {}} onPrimary={() => {}} onDiscard={() => {}} />
    ))
    expect(view.container.textContent).toContain('!')
    expect(view.queryByTitle('Stage')).toBeTruthy()
    expect(view.queryByTitle('Discard')).toBeFalsy()
  })
})
