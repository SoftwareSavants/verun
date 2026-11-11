import { expect, test, vi } from 'vitest'

test('the sidebar remembers whether it lists tasks by project or by recent activity', async () => {
  localStorage.clear()
  let mod = await import('./sidebarView')
  expect(mod.sidebarView()).toBe('projects')
  mod.setSidebarView('recent')
  vi.resetModules()
  mod = await import('./sidebarView')
  expect(mod.sidebarView()).toBe('recent')
})
