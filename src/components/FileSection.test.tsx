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
        open={true}
        onToggle={() => {}}
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
        open={true}
        onToggle={() => {}}
      />
    ))
    expect(container.textContent).not.toContain('Staged Changes')
  })

  test('clicking the header fires onToggle', () => {
    cleanup()
    const onToggle = vi.fn()
    const { getByText } = render(() => (
      <FileSection
        kind="staged"
        title="Staged"
        entries={[e('a.ts', 'staged')]}
        renderRow={() => <div data-testid="row">row</div>}
        bulkActions={[]}
        open={true}
        onToggle={onToggle}
      />
    ))
    fireEvent.click(getByText('Staged'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  test('rows are hidden when open is false', () => {
    cleanup()
    const { container } = render(() => (
      <FileSection
        kind="staged"
        title="Staged"
        entries={[e('a.ts', 'staged')]}
        renderRow={() => <div data-testid="row">row</div>}
        bulkActions={[]}
        open={false}
        onToggle={() => {}}
      />
    ))
    expect(container.querySelector('[data-testid=row]')).toBeFalsy()
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
        open={true}
        onToggle={() => {}}
      />
    ))
    fireEvent.click(getByTitle('Stage All'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
