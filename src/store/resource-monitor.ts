import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import type { ResourceSample } from '../lib/ipc'

export const [resourceSample, setResourceSample] = createSignal<ResourceSample | null>(null)

let initPromise: Promise<void> | null = null

export function initResourceMonitor(): Promise<void> {
  if (!initPromise) {
    initPromise = listen<ResourceSample>('resource_usage', (e) => {
      setResourceSample(e.payload)
    }).then(() => {})
  }
  return initPromise
}
