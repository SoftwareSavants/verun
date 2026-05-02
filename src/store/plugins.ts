import { createStore } from 'solid-js/store'
import { createSignal } from 'solid-js'
import type { PluginCatalog, MarketplaceInfo, PluginScope } from '../types'
import * as ipc from '../lib/ipc'
import { addToast } from './ui'

export const [catalog, setCatalog] = createStore<PluginCatalog>({ installed: [], available: [] })
export const [marketplaces, setMarketplaces] = createStore<MarketplaceInfo[]>([])
export const [isSupported, setIsSupported] = createSignal<boolean | null>(null)
export const [isLoading, setIsLoading] = createSignal(false)
export const [pending, setPending] = createStore<Record<string, true>>({})
export const [selectedPluginId, setSelectedPluginId] = createSignal<string | null>(null)

export function isPending(pluginId: string): boolean {
  return !!pending[pluginId]
}

export function isInstalled(pluginId: string): boolean {
  return catalog.installed.some(p => p.id === pluginId)
}

export function installedPluginById(pluginId: string) {
  return catalog.installed.find(p => p.id === pluginId)
}

export async function loadCatalog() {
  setIsLoading(true)
  try {
    const supported = await ipc.pluginIsSupported()
    setIsSupported(supported)
    if (!supported) return
    const [cat, mps] = await Promise.all([
      ipc.pluginListCatalog(),
      ipc.pluginListMarketplaces(),
    ])
    setCatalog(cat)
    setMarketplaces(mps)
  } catch (e) {
    addToast(`Failed to load plugin catalog: ${e}`, 'error')
  } finally {
    setIsLoading(false)
  }
}

export async function installPlugin(pluginId: string, scope: PluginScope, cwd: string) {
  setPending(pluginId, true)
  try {
    await ipc.pluginInstall(pluginId, scope, cwd)
    await loadCatalog()
    addToast(`Installed ${pluginId}`, 'success')
  } catch (e) {
    addToast(`Install failed: ${e}`, 'error')
  } finally {
    setPending(pluginId, undefined as unknown as true)
  }
}

export async function uninstallPlugin(pluginId: string, cwd: string) {
  setPending(pluginId, true)
  try {
    await ipc.pluginUninstall(pluginId, cwd)
    await loadCatalog()
    addToast(`Uninstalled ${pluginId}`, 'success')
  } catch (e) {
    addToast(`Uninstall failed: ${e}`, 'error')
  } finally {
    setPending(pluginId, undefined as unknown as true)
  }
}
