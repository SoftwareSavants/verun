import { describe, test, expect, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { ChangesHeader } from './ChangesHeader'

describe('<ChangesHeader />', () => {
  test('shows zero conflict + zero staged segments hidden, changes count visible', () => {
    cleanup()
    const { container } = render(() => (
      <ChangesHeader
        conflicts={0}
        staged={0}
        changes={5}
        totalInsertions={10}
        totalDeletions={3}
        loading={false}
        onRefresh={() => {}}
        onJumpToSection={() => {}}
      />
    ))
    expect(container.textContent).not.toContain('conflicts')
    expect(container.textContent).not.toContain('staged')
    expect(container.textContent).toContain('5')
    expect(container.textContent).toContain('+10')
    expect(container.textContent).toContain('-3')
  })

  test('conflict segment uses red text and pulses when count > 0', () => {
    cleanup()
    const { container } = render(() => (
      <ChangesHeader
        conflicts={2}
        staged={0}
        changes={0}
        totalInsertions={0}
        totalDeletions={0}
        loading={false}
        onRefresh={() => {}}
        onJumpToSection={() => {}}
      />
    ))
    const seg = container.querySelector('[data-testid=conflict-seg]') as HTMLElement
    expect(seg).toBeTruthy()
    expect(seg.className).toContain('red')
    expect(seg.className).toContain('animate-pulse')
  })

  test('clicking a segment calls onJumpToSection', () => {
    cleanup()
    const onJump = vi.fn()
    const { getByTestId } = render(() => (
      <ChangesHeader
        conflicts={1}
        staged={2}
        changes={3}
        totalInsertions={0}
        totalDeletions={0}
        loading={false}
        onRefresh={() => {}}
        onJumpToSection={onJump}
      />
    ))
    fireEvent.click(getByTestId('staged-seg'))
    expect(onJump).toHaveBeenCalledWith('staged')
  })

  test('refresh button calls onRefresh', () => {
    cleanup()
    const onRefresh = vi.fn()
    const { getByTitle } = render(() => (
      <ChangesHeader
        conflicts={0} staged={0} changes={0}
        totalInsertions={0} totalDeletions={0}
        loading={false}
        onRefresh={onRefresh}
        onJumpToSection={() => {}}
      />
    ))
    fireEvent.click(getByTitle('Refresh'))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
