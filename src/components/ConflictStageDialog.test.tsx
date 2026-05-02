import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { ConflictStageDialog } from './ConflictStageDialog'

describe('<ConflictStageDialog />', () => {
  test('does not render when path is null', () => {
    cleanup()
    const { container } = render(() => (
      <ConflictStageDialog path={null} onChoose={() => {}} onClose={() => {}} />
    ))
    expect(container.textContent).toBe('')
  })

  test('clicking Accept ours fires onChoose("ours")', () => {
    cleanup()
    const onChoose = vi.fn()
    const { getByText } = render(() => (
      <ConflictStageDialog path="src/foo.ts" onChoose={onChoose} onClose={() => {}} />
    ))
    fireEvent.click(getByText(/Accept ours/i))
    expect(onChoose).toHaveBeenCalledWith('ours')
  })

  test('clicking Accept theirs fires onChoose("theirs")', () => {
    cleanup()
    const onChoose = vi.fn()
    const { getByText } = render(() => (
      <ConflictStageDialog path="src/foo.ts" onChoose={onChoose} onClose={() => {}} />
    ))
    fireEvent.click(getByText(/Accept theirs/i))
    expect(onChoose).toHaveBeenCalledWith('theirs')
  })

  test('clicking Stage as-is fires onChoose("asIs")', () => {
    cleanup()
    const onChoose = vi.fn()
    const { getByText } = render(() => (
      <ConflictStageDialog path="src/foo.ts" onChoose={onChoose} onClose={() => {}} />
    ))
    fireEvent.click(getByText(/Stage as-is/i))
    expect(onChoose).toHaveBeenCalledWith('asIs')
  })
})
