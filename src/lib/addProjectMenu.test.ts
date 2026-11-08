import { describe, it, expect, vi } from 'vitest'
import { buildAddProjectMenuItems } from './addProjectMenu'

describe('buildAddProjectMenuItems', () => {
  it('returns the quick task and three project items with stable labels', () => {
    const items = buildAddProjectMenuItems({
      onAddExisting: () => {},
      onCreateNew: () => {},
      onCloneRepo: () => {},
      onQuickTask: () => {},
    })
    const labels = items
      .filter((it): it is Extract<typeof it, { label: string }> => 'label' in it)
      .map((it) => it.label)
    expect(labels).toEqual([
      'Quick task in any folder...',
      'Add existing project...',
      'Bootstrap a new project...',
      'Clone repo',
    ])
  })

  it('items fire their respective handlers', () => {
    const onAddExisting = vi.fn()
    const onCreateNew = vi.fn()
    const onCloneRepo = vi.fn()
    const onQuickTask = vi.fn()
    const items = buildAddProjectMenuItems({ onAddExisting, onCreateNew, onCloneRepo, onQuickTask })
    const [quick, first, second, third] = items.filter(
      (it): it is Extract<typeof it, { label: string }> => 'label' in it,
    )
    quick.action()
    expect(onQuickTask).toHaveBeenCalledTimes(1)
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
