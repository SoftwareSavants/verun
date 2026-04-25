import { Component, Show, createSignal, onMount } from 'solid-js'
import { Portal } from 'solid-js/web'
import { HardDrive, Loader2, X } from 'lucide-solid'
import { QuantityStepper } from './QuantityStepper'
import {
  getBlobTtlDays, setBlobTtlDays,
  getBlobCapMb, setBlobCapMb,
  storageStats, refreshStorageStats, runConfiguredGc,
} from '../store/storage'
import { addToast } from '../store/ui'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

export const StorageSettings: Component = () => {
  const [ttl, setTtl] = createSignal(getBlobTtlDays())
  const [cap, setCap] = createSignal(getBlobCapMb())
  const [running, setRunning] = createSignal(false)
  const [breakdownOpen, setBreakdownOpen] = createSignal(false)

  onMount(() => { void refreshStorageStats() })

  const onTtlChange = (v: number) => {
    setTtl(v)
    setBlobTtlDays(v)
  }
  const onCapChange = (v: number) => {
    setCap(v)
    setBlobCapMb(v)
  }

  const runNow = async () => {
    setRunning(true)
    const report = await runConfiguredGc()
    setRunning(false)
    if (!report) {
      addToast('Cleanup failed', 'error', { duration: 4000 })
      return
    }
    const total = report.reclaimedUnreferenced + report.reclaimedCapped
    addToast(
      total === 0 ? 'Nothing to clean up' : `Reclaimed ${total} blob${total === 1 ? '' : 's'}`,
      'success',
      { duration: 3000 },
    )
  }

  const openBreakdown = async () => {
    await refreshStorageStats()
    setBreakdownOpen(true)
  }

  return (
    <div class="mb-8">
      <h2 class="section-title mb-4">Storage</h2>

      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-text-primary">Keep unused attachments for</div>
            <div class="text-xs text-text-dim mt-0.5">Days before unreferenced blobs are reclaimed (0 disables TTL)</div>
          </div>
          <div class="flex items-center gap-2">
            <QuantityStepper value={ttl()} min={0} max={365} step={1} onChange={onTtlChange} />
            <span class="text-xs text-text-dim w-8">days</span>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-text-primary">Attachment storage cap</div>
            <div class="text-xs text-text-dim mt-0.5">Maximum disk usage before LRU eviction (0 disables cap)</div>
          </div>
          <div class="flex items-center gap-2">
            <QuantityStepper value={cap()} min={0} max={102400} step={128} onChange={onCapChange} />
            <span class="text-xs text-text-dim w-8">MB</span>
          </div>
        </div>

        <div class="flex items-center gap-2 pt-1">
          <button
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-surface-2 ring-1 ring-outline/8 text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-50"
            onClick={runNow}
            disabled={running()}
          >
            <Show when={running()} fallback={<HardDrive size={14} />}><Loader2 size={14} class="animate-spin" /></Show>
            Run cleanup now
          </button>
          <button
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
            onClick={openBreakdown}
          >
            View breakdown
          </button>
        </div>
      </div>

      <Show when={breakdownOpen()}>
        <Portal>
          <div
            class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60"
            onClick={(e) => { if (e.target === e.currentTarget) setBreakdownOpen(false) }}
          >
            <div class="bg-surface-1 ring-1 ring-outline/15 rounded-xl shadow-2xl w-[420px] max-w-[90vw] p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-base font-semibold text-text-primary">Storage breakdown</h3>
                <button class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-2" onClick={() => setBreakdownOpen(false)}>
                  <X size={15} />
                </button>
              </div>

              <Show when={storageStats()} fallback={<div class="text-sm text-text-dim">Loading...</div>}>
                {(stats) => (
                  <div class="space-y-3">
                    <Row label="Total" bytes={stats().totalBytes} count={stats().blobCount} />
                    <Row label="Referenced (in use)" bytes={stats().referencedBytes} count={stats().referencedCount} />
                    <Row label="Unreferenced (eligible for cleanup)" bytes={stats().unreferencedBytes} count={stats().unreferencedCount} muted />
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  )
}

const Row: Component<{ label: string; bytes: number; count: number; muted?: boolean }> = (props) => (
  <div class={`flex items-center justify-between ${props.muted ? 'text-text-dim' : 'text-text-secondary'}`}>
    <div class="text-sm">{props.label}</div>
    <div class="text-sm tabular-nums">{formatBytes(props.bytes)} <span class="text-text-dim">({props.count})</span></div>
  </div>
)
