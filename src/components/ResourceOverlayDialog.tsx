import { Component, For, Show, createEffect, onCleanup } from 'solid-js'
import { Dialog } from './Dialog'
import { resourceSample, setResourceSample } from '../store/resource-monitor'
import { formatBytes, formatPct } from '../lib/format'
import { setResourceMonitorOverlayOpen, getResourceUsageNow } from '../lib/ipc'

interface Props {
  open: boolean
  onClose: () => void
}

export const ResourceOverlayDialog: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return
    void setResourceMonitorOverlayOpen(true)
    void getResourceUsageNow().then(setResourceSample)
    onCleanup(() => { void setResourceMonitorOverlayOpen(false) })
  })

  return (
    <Dialog open={props.open} onClose={props.onClose} width="42rem">
      <div data-testid="resource-overlay" class="p-4">
        <Show
          when={resourceSample()}
          fallback={<div class="text-text-dim">Sampling…</div>}
        >
          {(s) => (
            <>
              <div class="mb-3">
                <div class="text-2xl tabular-nums">
                  {formatBytes(s().total.rssBytes)}
                  <span class="text-text-dim text-base ml-2">{formatPct(s().total.cpuPct)}</span>
                </div>
                <div class="text-xs text-text-dim mt-1">
                  Verun (app): {formatBytes(s().app.rssBytes)} · {formatPct(s().app.cpuPct)}
                </div>
              </div>
              <div class="border-t-1 border-t-solid border-t-outline/8 pt-2">
                <div class="grid grid-cols-[1fr_5rem_4rem] gap-2 text-xs text-text-dim mb-1">
                  <div>Task</div>
                  <div class="text-right">RAM</div>
                  <div class="text-right">CPU</div>
                </div>
                <For each={s().tasks}>{(t) => (
                  <div
                    data-testid="resource-task-row"
                    class="grid grid-cols-[1fr_5rem_4rem] gap-2 py-1 text-sm tabular-nums"
                  >
                    <div class="truncate">{t.taskName}</div>
                    <div class="text-right">{formatBytes(t.rssBytes)}</div>
                    <div class="text-right">{formatPct(t.cpuPct)}</div>
                  </div>
                )}</For>
              </div>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
