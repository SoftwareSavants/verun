import { expect, test, vi } from 'vitest'

test('the sidebar remembers whether it lists tasks by project or by status', async () => {
  localStorage.clear()
  let mod = await import('./sidebarView')
  expect(mod.sidebarView()).toBe('projects')
  mod.setSidebarView('status')
  vi.resetModules()
  mod = await import('./sidebarView')
  expect(mod.sidebarView()).toBe('status')
})
