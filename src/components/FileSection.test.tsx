import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { FileSection } from './FileSection'
import type { FileEntry } from '../lib/gitStatus'

const e = (path: string, kind: FileEntry['kind'] = 'unstaged'): FileEntry => ({
  kind,
  file: { path, indexStatus: ' ', worktreeStatus: 'M', conflict: null },
} as FileEntry)

const noopRow = () => <div>row</div>

describe('<FileSection />', () => {
  test('renders title and count', () => {
    cleanup()
    const { container } = render(() => (
      <FileSection
        kind="staged"
        title="Staged Changes"
        entries={[e('a.ts', 'staged'), e('b.ts', 'staged')]}
        renderRow={noopRow}
        bulkActions={[]}
      />
    ))
    expect(container.textContent).toContain('Staged Changes')
    expect(container.textContent).toContain('2')
  })

  test('section is hidden when entries is empty', () => {
    cleanup()
    const { container } = render(() => (
      <FileSection
        kind="staged"
        title="Staged Changes"
        entries={[]}
        renderRow={noopRow}
        bulkActions={[]}
      />
    ))
    expect(container.textContent).not.toContain('Staged Changes')
  })

  test('clicking the header toggles open state', () => {
    cleanup()
    localStorage.removeItem('verun:changes:section:staged:open')
    const { container, getByText } = render(() => (
      <FileSection
        kind="staged"
        title="Staged"
        entries={[e('a.ts', 'staged')]}
        renderRow={() => <div data-testid="row">row</div>}
        bulkActions={[]}
      />
    ))
    expect(container.querySelector('[data-testid=row]')).toBeTruthy()
    fireEvent.click(getByText('Staged'))
    expect(container.querySelector('[data-testid=row]')).toBeFalsy()
    expect(localStorage.getItem('verun:changes:section:staged:open')).toBe('false')
  })

  test('bulk action button fires its handler', () => {
    cleanup()
    const onClick = vi.fn()
    const { getByTitle } = render(() => (
      <FileSection
        kind="changes"
        title="Changes"
        entries={[e('a.ts')]}
        renderRow={noopRow}
        bulkActions={[{ icon: () => <span>+</span>, title: 'Stage All', onClick }]}
      />
    ))
    fireEvent.click(getByTitle('Stage All'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
