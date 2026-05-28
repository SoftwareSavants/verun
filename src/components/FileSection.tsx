import { Component, Show, For, JSX } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { ChevronDown, ChevronRight } from 'lucide-solid'
import type { FileEntry } from '../lib/gitStatus'

export type SectionKind = 'conflicts' | 'staged' | 'changes'

export interface BulkAction {
  icon: Component<{ size: number }>
  title: string
  onClick: () => void | Promise<void>
}

interface Props {
  kind: SectionKind
  title: string
  entries: FileEntry[]
  renderRow: (entry: FileEntry, index: number) => JSX.Element
  bulkActions: BulkAction[]
  open: boolean
  onToggle: () => void
}

export const FileSection: Component<Props> = (props) => {
  let scrollRef: HTMLDivElement | undefined

  const virt = createVirtualizer({
    get count() { return props.entries.length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 28,
    overscan: 10,
    initialRect: { width: 280, height: 320 },
  })

  const visibleRows = () => {
    const rows = virt.getVirtualItems()
    if (rows.length > 0 || props.entries.length === 0) return rows
    const size = 28
    return Array.from({ length: Math.min(props.entries.length, 20) }, (_, index) => ({
      key: index,
      index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }))
  }

  return (
    <Show when={props.entries.length > 0}>
      <div class="flex flex-col min-h-0">
        <div class="group flex items-center gap-1.5 px-3 h-7 hover:bg-surface-2 cursor-pointer select-none" onClick={props.onToggle}>
          {props.open ? <ChevronDown size={12} class="text-text-dim shrink-0" /> : <ChevronRight size={12} class="text-text-dim shrink-0" />}
          <span class="text-xs font-medium text-text-secondary uppercase tracking-wide">{props.title}</span>
          <span class="text-[10px] text-text-dim tabular-nums">({props.entries.length})</span>
          <span class="flex-1" />
          <span class="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <For each={props.bulkActions}>
              {(action) => {
                const Icon = action.icon
                return (
                  <button
                    class="h-4 w-4 flex items-center justify-center rounded text-text-dim hover:text-text-secondary hover:bg-surface-3"
                    title={action.title}
                    onClick={(e) => { e.stopPropagation(); action.onClick() }}
                  >
                    <Icon size={12} />
                  </button>
                )
              }}
            </For>
          </span>
        </div>

        <Show when={props.open}>
          <div ref={scrollRef} class="overflow-auto" style={{ 'max-height': '40vh' }}>
            <div style={{ height: `${virt.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              <For each={visibleRows()}>
                {(vrow) => (
                  <div
                    class="absolute left-0 top-0 w-full"
                    style={{
                      height: `${vrow.size}px`,
                      transform: `translateY(${vrow.start}px)`,
                    }}
                  >
                    {props.renderRow(props.entries[vrow.index], vrow.index)}
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
