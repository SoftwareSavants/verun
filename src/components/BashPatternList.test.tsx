import { render, fireEvent, cleanup } from '@solidjs/testing-library'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { BashPatternList } from './BashPatternList'
import { HARD_BLOCK_PATTERNS } from '../types'

describe('BashPatternList (global mode)', () => {
  afterEach(cleanup)

  it('renders locked rows + user-removable rows', () => {
    const { getByText, container } = render(() => (
      <BashPatternList
        mode="global"
        patterns={[
          { id: 'sudo', pattern: 'sudo', builtin: true },
        ]}
        hardBlocks={HARD_BLOCK_PATTERNS}
        onChange={() => {}}
      />
    ))
    expect(getByText('git worktree prune')).toBeTruthy()
    expect(getByText('sudo')).toBeTruthy()
    expect(container.querySelectorAll('[data-locked="true"]').length).toBe(HARD_BLOCK_PATTERNS.length)
  })

  it('removes a non-locked pattern', () => {
    const onChange = vi.fn()
    const { getByLabelText } = render(() => (
      <BashPatternList
        mode="global"
        patterns={[{ id: 'sudo', pattern: 'sudo', builtin: true }]}
        hardBlocks={HARD_BLOCK_PATTERNS}
        onChange={onChange}
      />
    ))
    fireEvent.click(getByLabelText('Remove sudo'))
    expect(onChange).toHaveBeenCalledWith([])
  })
})

describe('BashPatternList (project mode)', () => {
  afterEach(cleanup)

  it('toggles a global pattern on/off', () => {
    const onProjectBashChange = vi.fn()
    const { getByLabelText } = render(() => (
      <BashPatternList
        mode="project"
        global={[{ id: 'sudo', pattern: 'sudo', builtin: true }]}
        projectBash={{ disabledGlobal: [], extra: [] }}
        hardBlocks={HARD_BLOCK_PATTERNS}
        onProjectBashChange={onProjectBashChange}
      />
    ))
    fireEvent.click(getByLabelText('Toggle sudo'))
    expect(onProjectBashChange).toHaveBeenCalledWith({ disabledGlobal: ['sudo'], extra: [] })
  })
})
