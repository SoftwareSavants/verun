import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'

const mocks = vi.hoisted(() => ({
  isInstalled: vi.fn(() => false),
  isPending: vi.fn(() => false),
  installPlugin: vi.fn().mockResolvedValue(undefined),
  uninstallPlugin: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../store/plugins', () => mocks)

import { PluginCard } from './PluginCard'
import type { AvailablePlugin } from '../types'

const sample: AvailablePlugin = {
  pluginId: 'asana@claude-plugins-official',
  name: 'asana',
  description: 'Asana integration',
  marketplaceName: 'claude-plugins-official',
  source: './external_plugins/asana',
  installCount: 8126,
}

describe('PluginCard', () => {
  beforeEach(() => {
    cleanup()
    mocks.isInstalled.mockReturnValue(false)
    mocks.isPending.mockReturnValue(false)
    mocks.installPlugin.mockClear()
    mocks.uninstallPlugin.mockClear()
  })

  test('renders name, description, and install count', () => {
    const { getByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" allowProjectScope={true} showMarketplace={true} />)
    expect(getByText('asana')).toBeTruthy()
    expect(getByText(/Asana integration/)).toBeTruthy()
    expect(getByText(/8,126/)).toBeTruthy()
  })

  test('clicking Install calls installPlugin with default scope user', () => {
    const { getByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" allowProjectScope={true} showMarketplace={true} />)
    fireEvent.click(getByText('Install'))
    expect(mocks.installPlugin).toHaveBeenCalledWith('asana@claude-plugins-official', 'user', '/tmp')
  })

  test('shows Uninstall when already installed', () => {
    mocks.isInstalled.mockReturnValue(true)
    const { getByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" allowProjectScope={true} showMarketplace={true} />)
    expect(getByText('Uninstall')).toBeTruthy()
  })

  test('hides scope picker when allowProjectScope is false', () => {
    const { queryByTitle } = render(() => <PluginCard plugin={sample} cwd="/tmp" allowProjectScope={false} showMarketplace={true} />)
    expect(queryByTitle('Install scope')).toBeNull()
  })

  test('hides marketplace badge when showMarketplace is false', () => {
    const { queryByText } = render(() => <PluginCard plugin={sample} cwd="/tmp" allowProjectScope={true} showMarketplace={false} />)
    expect(queryByText('claude-plugins-official')).toBeNull()
  })
})
