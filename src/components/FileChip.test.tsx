import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { FileChip } from './FileChip'

afterEach(cleanup)

const file = { hash: 'h', mimeType: 'text/markdown', name: 'Handoff from Claude Code.md', size: 2048 }

test('shows the file name and size', () => {
  const { getByText, getByTitle } = render(() => <FileChip file={file} />)
  expect(getByText('Handoff from Claude Code.md')).toBeTruthy()
  expect(getByTitle('Handoff from Claude Code.md · 2.00 KB')).toBeTruthy()
})

test('offers a remove button only when it can be removed', () => {
  const onRemove = vi.fn()
  const { getByLabelText, unmount } = render(() => <FileChip file={file} onRemove={onRemove} />)
  fireEvent.click(getByLabelText('Remove Handoff from Claude Code.md'))
  expect(onRemove).toHaveBeenCalledOnce()
  unmount()
  const { queryByLabelText } = render(() => <FileChip file={file} />)
  expect(queryByLabelText(/Remove/)).toBeNull()
})
