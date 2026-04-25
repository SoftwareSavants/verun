import { describe, it, expect, vi } from 'vitest'
import { buildAddProjectMenuItems } from './addProjectMenu'

describe('buildAddProjectMenuItems', () => {
  it('returns two non-separator items with stable labels', () => {
    const items = buildAddProjectMenuItems({ onAddExisting: () => {}, onCreateNew: () => {} })
    const labels = items
      .filter((it): it is Extract<typeof it, { label: string }> => 'label' in it)
      .map((it) => it.label)
    expect(labels).toEqual(['Add existing project...', 'Bootstrap a new project...'])
  })

  it('first item fires onAddExisting, second fires onCreateNew', () => {
    const onAddExisting = vi.fn()
    const onCreateNew = vi.fn()
    const items = buildAddProjectMenuItems({ onAddExisting, onCreateNew })
    const [first, second] = items.filter((it): it is Extract<typeof it, { label: string }> => 'label' in it)
    first.action()
    expect(onAddExisting).toHaveBeenCalledTimes(1)
    expect(onCreateNew).not.toHaveBeenCalled()
    second.action()
    expect(onCreateNew).toHaveBeenCalledTimes(1)
    expect(onAddExisting).toHaveBeenCalledTimes(1)
  })
})
