import { Component, For, Show, createEffect, onCleanup } from 'solid-js'
import { Popover } from './Popover'
import { resourceSample, setResourceSample } from '../store/resource-monitor'
import { formatBytes, formatPct } from '../lib/format'
import { setResourceMonitorOverlayOpen, getResourceUsageNow } from '../lib/ipc'

interface Props {
  open: boolean
  onClose: () => void
  anchor?: { x: number; y: number }
}

export const ResourceOverlay: Component<Props> = (props) => {
  createEffect(() => {
    if (!props.open) return
    void setResourceMonitorOverlayOpen(true)
    void getResourceUsageNow().then(setResourceSample)
    onCleanup(() => { void setResourceMonitorOverlayOpen(false) })
  })

  return (
    <Popover
      open={props.open}
      onClose={props.onClose}
      pos={props.anchor}
      class="-translate-x-full w-80 p-3"
    >
      <div data-testid="resource-overlay">
        <Show
          when={resourceSample()}
          fallback={<div class="text-text-dim text-sm">Sampling…</div>}
        >
          {(s) => (
            <>
              <div class="mb-3">
                <div class="text-xl tabular-nums">
                  {formatBytes(s().total.rssBytes)}
                  <span class="text-text-dim text-sm ml-2">{formatPct(s().total.cpuPct)}</span>
                </div>
                <div class="text-xs text-text-dim mt-0.5">
                  Verun (app): {formatBytes(s().app.rssBytes)} · {formatPct(s().app.cpuPct)}
                </div>
              </div>
              <div class="border-t-1 border-t-solid border-t-outline/8 pt-2">
                <div class="grid grid-cols-[1fr_4.5rem_3.5rem] gap-2 text-xs text-text-dim mb-1">
                  <div>Task</div>
                  <div class="text-right">RAM</div>
                  <div class="text-right">CPU</div>
                </div>
                <For each={s().tasks}>{(t) => (
                  <div
                    data-testid="resource-task-row"
                    class="grid grid-cols-[1fr_4.5rem_3.5rem] gap-2 py-1 items-start text-sm tabular-nums"
                  >
                    <div class="min-w-0">
                      <div class="truncate">{t.taskName}</div>
                      <Show when={t.branch}>
                        <div class="truncate text-xs text-text-dim">{t.branch}</div>
                      </Show>
                    </div>
                    <div class="text-right">{formatBytes(t.rssBytes)}</div>
                    <div class="text-right">{formatPct(t.cpuPct)}</div>
                  </div>
                )}</For>
              </div>
            </>
          )}
        </Show>
      </div>
    </Popover>
  )
}
