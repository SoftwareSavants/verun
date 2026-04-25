import { createSignal } from 'solid-js'
import * as ipc from '../lib/ipc'
import type { StorageStats } from '../types'

// Hard-coded defaults the user can override in Settings.
//   TTL: how long an unreferenced blob may live before GC reclaims it
//   Cap: total disk budget; LRU-evicts unreferenced blobs when over
export const DEFAULT_BLOB_TTL_DAYS = 30
export const DEFAULT_BLOB_CAP_MB = 1024

const TTL_KEY = 'verun:blob-ttl-days'
const CAP_KEY = 'verun:blob-cap-mb'

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function getBlobTtlDays(): number {
  return readNumber(TTL_KEY, DEFAULT_BLOB_TTL_DAYS)
}

export function setBlobTtlDays(days: number) {
  localStorage.setItem(TTL_KEY, String(days))
}

export function getBlobCapMb(): number {
  return readNumber(CAP_KEY, DEFAULT_BLOB_CAP_MB)
}

export function setBlobCapMb(mb: number) {
  localStorage.setItem(CAP_KEY, String(mb))
}

const [storageStats, setStorageStats] = createSignal<StorageStats | null>(null)
export { storageStats }

export async function refreshStorageStats() {
  try {
    setStorageStats(await ipc.getStorageStats())
  } catch (e) {
    console.error('refreshStorageStats failed', e)
  }
}

/** Run GC with the user's configured TTL + cap. Returns reclaim counts. */
export async function runConfiguredGc(): Promise<ipc.GcReport | null> {
  try {
    const ttlMs = getBlobTtlDays() * 86_400_000
    const maxBytes = getBlobCapMb() * 1024 * 1024
    const report = await ipc.runBlobGc(ttlMs, maxBytes)
    await refreshStorageStats()
    return report
  } catch (e) {
    console.error('runConfiguredGc failed', e)
    return null
  }
}
