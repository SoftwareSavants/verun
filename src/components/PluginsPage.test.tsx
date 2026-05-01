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
  return { catalog: cat, marketplaces: mps, ...mocks }
})

vi.mock('../store/ui', () => ({
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
    const { getByText } = render(() => <PluginsPage />)
    expect(getByText('asana')).toBeTruthy()
    expect(getByText('amplitude')).toBeTruthy()
    expect(getByText('foo')).toBeTruthy()
  })

  test('search filters by name', async () => {
    const { getByPlaceholderText, queryByText, getByText } = render(() => <PluginsPage />)
    const search = getByPlaceholderText(/search/i)
    fireEvent.input(search, { target: { value: 'amp' } })
    await waitFor(() => {
      expect(queryByText('asana')).toBeNull()
      expect(queryByText('foo')).toBeNull()
    })
    expect(getByText('amplitude')).toBeTruthy()
  })

  test('installed-only toggle hides un-installed', async () => {
    const { getByLabelText, queryByText, getByText } = render(() => <PluginsPage />)
    const toggle = getByLabelText(/installed only/i)
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(queryByText('amplitude')).toBeNull()
      expect(queryByText('foo')).toBeNull()
    })
    expect(getByText('asana')).toBeTruthy()
  })
})
