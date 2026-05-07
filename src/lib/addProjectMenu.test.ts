import { describe, it, expect, vi } from 'vitest'
import { buildAddProjectMenuItems } from './addProjectMenu'

describe('buildAddProjectMenuItems', () => {
  it('returns three non-separator items with stable labels', () => {
    const items = buildAddProjectMenuItems({
      onAddExisting: () => {},
      onCreateNew: () => {},
      onCloneRepo: () => {},
    })
    const labels = items
      .filter((it): it is Extract<typeof it, { label: string }> => 'label' in it)
      .map((it) => it.label)
    expect(labels).toEqual([
      'Add existing project...',
      'Bootstrap a new project...',
      'Clone repo',
    ])
  })

  it('items fire their respective handlers', () => {
    const onAddExisting = vi.fn()
    const onCreateNew = vi.fn()
    const onCloneRepo = vi.fn()
    const items = buildAddProjectMenuItems({ onAddExisting, onCreateNew, onCloneRepo })
    const [first, second, third] = items.filter(
      (it): it is Extract<typeof it, { label: string }> => 'label' in it,
    )
    first.action()
    expect(onAddExisting).toHaveBeenCalledTimes(1)
    expect(onCreateNew).not.toHaveBeenCalled()
    expect(onCloneRepo).not.toHaveBeenCalled()
    second.action()
    expect(onCreateNew).toHaveBeenCalledTimes(1)
    third.action()
    expect(onCloneRepo).toHaveBeenCalledTimes(1)
    expect(onAddExisting).toHaveBeenCalledTimes(1)
    expect(onCreateNew).toHaveBeenCalledTimes(1)
  })
})
