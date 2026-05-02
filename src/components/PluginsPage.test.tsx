import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library'
import { createStore } from 'solid-js/store'

const { catalog, marketplaces, mocks } = vi.hoisted(() => {
  const c = {
    installed: [{ id: 'asana@claude-plugins-official', scope: 'user', enabled: true }],
    available: [
      { pluginId: 'asana@claude-plugins-official', name: 'asana', description: 'Asana stuff', marketplaceName: 'claude-plugins-official', source: '', installCount: 100 },
      { pluginId: 'amplitude@claude-plugins-official', name: 'amplitude', description: 'Analytics', marketplaceName: 'claude-plugins-official', source: '', installCount: 50 },
      { pluginId: 'foo@other-mp', name: 'foo', description: 'A foo plugin', marketplaceName: 'other-mp', source: '', installCount: 999 },
    ],
  }
  const mp = [
    { name: 'claude-plugins-official' },
    { name: 'other-mp' },
  ]
  return {
    catalog: c,
    marketplaces: mp,
    mocks: {
      isSupported: vi.fn(() => true),
      isLoading: vi.fn(() => false),
      isInstalled: vi.fn((id: string) => id === 'asana@claude-plugins-official'),
      isPending: vi.fn(() => false),
      loadCatalog: vi.fn().mockResolvedValue(undefined),
      installPlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
    },
  }
})

vi.mock('../store/plugins', () => {
  const [cat] = createStore(catalog)
  const [mps] = createStore(marketplaces)
  return {
    catalog: cat,
    marketplaces: mps,
    selectedPluginId: () => null,
    setSelectedPluginId: vi.fn(),
    installedPluginById: () => undefined,
    ...mocks,
  }
})

vi.mock('../store/ui', () => ({
  showPlugins: () => true,
  setShowPlugins: vi.fn(),
  selectedProjectId: () => null,
  addToast: vi.fn(),
}))

vi.mock('../store/projects', () => {
  const [projects] = createStore<unknown[]>([])
  return { projects }
})

import { PluginsPage } from './PluginsPage'

describe('PluginsPage', () => {
  beforeEach(() => {
    cleanup()
  })

  test('renders all available plugins by default', () => {
    const { getAllByText } = render(() => <PluginsPage />)
    // Default stacks Installed / Popular / Browse, so plugins appear in
    // multiple sections — assert at least one render per name.
    expect(getAllByText('asana').length).toBeGreaterThan(0)
    expect(getAllByText('amplitude').length).toBeGreaterThan(0)
    expect(getAllByText('foo').length).toBeGreaterThan(0)
  })

  test('search filters the Browse all section but leaves Installed/Popular intact', async () => {
    const { getByPlaceholderText, getAllByText } = render(() => <PluginsPage />)
    // Baseline: with 3 plugins and cap=8, Popular renders all 3 once.
    // asana also renders in Installed → 3 total. amplitude/foo: 2 each (Popular + Browse).
    expect(getAllByText('asana').length).toBe(3)
    expect(getAllByText('amplitude').length).toBe(2)
    expect(getAllByText('foo').length).toBe(2)

    const search = getByPlaceholderText(/search/i)
    fireEvent.input(search, { target: { value: 'amp' } })
    await waitFor(() => {
      // Only Browse responds: foo drops from 2 → 1, asana from 3 → 2.
      expect(getAllByText('foo').length).toBe(1)
      expect(getAllByText('asana').length).toBe(2)
    })
    // amplitude still in both Popular and Browse.
    expect(getAllByText('amplitude').length).toBe(2)
  })

})
