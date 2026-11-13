import { describe, expect, test } from 'vitest'
import { sidebarOrder } from './sidebarOrder'

const t = (id: string) => ({ id })
const ids = (xs: { id: string }[]) => xs.map(x => x.id)

describe('sidebarOrder', () => {
  // Projects view: tasks under their projects, Needs you rows repeat tasks already listed there.
  test('in the projects view, shortcuts and arrows follow the project lists', () => {
    const o = sidebarOrder('projects', { byProject: [t('a'), t('b'), t('c')], recent: [t('c'), t('a')], needsYou: [t('b')] })
    expect(ids(o.numbered)).toEqual(['a', 'b', 'c'])
    expect(ids(o.navigation)).toEqual(['a', 'b', 'c'])
  })

  // Recent view: Needs you on top, then the recent list, as the screen shows them.
  test('in the recent view, they follow what the screen shows', () => {
    const o = sidebarOrder('recent', { byProject: [t('a'), t('b'), t('c'), t('d')], recent: [t('c'), t('a')], needsYou: [t('b')] })
    expect(ids(o.numbered)).toEqual(['c', 'a'])
    expect(ids(o.navigation)).toEqual(['b', 'c', 'a'])
  })
})
