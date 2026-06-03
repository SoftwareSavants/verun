import { Component, createSignal, createMemo, Show, For } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ChevronDown, ChevronRight, GitCommit, Circle, ClipboardCopy, Tag, ExternalLink, Undo2, RotateCcw } from 'lucide-solid'
import { clsx } from 'clsx'
import { taskGit } from '../store/git'
import type { BranchCommit } from '../types'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  taskId: string
  selectedCommit: string | null
  uncommittedCount: number
  onSelectCommit: (hash: string | null) => void
  onUndoLastCommit: () => void
  onRevertCommit: (commit: BranchCommit) => void
}

export const BranchCommits: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(localStorage.getItem('verun:commitsOpen') !== 'false')
  let scrollRef: HTMLDivElement | undefined

  const commits = (): BranchCommit[] => taskGit(props.taskId).commits

  const togglePanel = () => {
    const next = !open()
    setOpen(next)
    localStorage.setItem('verun:commitsOpen', String(next))
  }

  const virt = createVirtualizer({
    get count() { return commits().length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 28,
    overscan: 8,
    initialRect: { width: 280, height: 192 },
  })

  const visibleRows = createMemo(() => {
    const rows = virt.getVirtualItems()
    if (rows.length > 0 || commits().length === 0) return rows
    const size = 28
    return Array.from({ length: Math.min(commits().length, 10) }, (_, index) => ({
      key: index,
      index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }))
  })

  const [menu, setMenu] = createSignal<{ x: number; y: number; commit: BranchCommit; isLast: boolean } | null>(null)
  const closeMenu = () => setMenu(null)

  const commitUrl = (hash: string): string | null => {
    const gh = taskGit(props.taskId).github
    if (!gh?.url) return null
    return `${gh.url.replace(/\/+$/, '')}/commit/${hash}`
  }

  const menuItems = (): ContextMenuItem[] => {
    const m = menu()
    if (!m) return []
    const items: ContextMenuItem[] = []
    if (m.isLast) {
      items.push({
        label: 'Undo last commit',
        icon: Undo2,
        action: () => { props.onUndoLastCommit(); closeMenu() },
      })
    }
    items.push({
      label: 'Revert this commit',
      icon: RotateCcw,
      action: () => { props.onRevertCommit(m.commit); closeMenu() },
    })
    items.push({ separator: true })
    items.push({
      label: 'Copy SHA',
      icon: ClipboardCopy,
      action: () => { navigator.clipboard.writeText(m.commit.hash); closeMenu() },
    })
    items.push({
      label: 'Copy message',
      icon: Tag,
      action: () => { navigator.clipboard.writeText(m.commit.message); closeMenu() },
    })
    const url = commitUrl(m.commit.hash)
    if (url) {
      items.push({
        label: 'Open on GitHub',
        icon: ExternalLink,
        action: () => { openUrl(url); closeMenu() },
      })
    }
    return items
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000)
    const diff = Date.now() - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
    return `${Math.floor(diff / 86400_000)}d ago`
  }

  return (
    <div class="shrink-0">
      <div class="h-px bg-outline/8 shrink-0" />
      <button
        class="w-full h-8 flex items-center gap-1.5 px-3 text-xs hover:bg-surface-2"
        onClick={togglePanel}
      >
        {open() ? <ChevronDown size={12} class="text-text-dim shrink-0" /> : <ChevronRight size={12} class="text-text-dim shrink-0" />}
        <GitCommit size={12} class="text-text-dim shrink-0" />
        <span class="font-medium text-text-secondary">Branch Commits</span>
        <Show when={commits().length > 0}>
          <span class="text-text-dim text-[10px] tabular-nums">{commits().length}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div ref={scrollRef} class="max-h-48 overflow-auto">
          <button
            class={clsx(
              'relative w-full flex items-center gap-2 px-3 py-1.5 text-xs',
              props.selectedCommit === null
                ? 'bg-surface-2 text-text-primary'
                : 'hover:bg-surface-2 text-text-secondary',
            )}
            style={props.selectedCommit === null ? { 'box-shadow': 'inset 2px 0 0 #2d6e4f' } : undefined}
            onClick={() => props.onSelectCommit(null)}
          >
            <Circle size={11} class="shrink-0 text-text-dim" />
            <span class="truncate flex-1 text-left">Uncommitted changes</span>
            <Show when={props.uncommittedCount > 0}>
              <span class="text-[10px] text-text-dim shrink-0">
                {props.uncommittedCount} file{props.uncommittedCount !== 1 ? 's' : ''}
              </span>
            </Show>
          </button>

          <div style={{ height: `${virt.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            <For each={visibleRows()}>
              {(vrow) => {
                const commit = () => commits()[vrow.index]
                return (
                  <Show when={commit()}>
                    {(c) => {
                      const isSelected = () => props.selectedCommit === c().hash
                      return (
                        <button
                          class={clsx(
                            'absolute left-0 top-0 w-full flex items-center gap-2 px-3 py-1.5 text-xs',
                            isSelected() ? 'bg-surface-2 text-text-primary' : 'hover:bg-surface-2 text-text-secondary',
                          )}
                          style={{
                            height: `${vrow.size}px`,
                            transform: `translateY(${vrow.start}px)`,
                            'box-shadow': isSelected() ? 'inset 2px 0 0 #2d6e4f' : undefined,
                          }}
                          onClick={() => props.onSelectCommit(c().hash)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setMenu({ x: e.clientX, y: e.clientY, commit: c(), isLast: vrow.index === 0 })
                          }}
                        >
                          <span class="font-mono text-text-dim text-[10px] shrink-0">{c().shortHash}</span>
                          <span class="truncate flex-1 text-left">{c().message}</span>
                          <span class="text-[10px] text-text-dim shrink-0">{formatTime(c().timestamp)}</span>
                        </button>
                      )
                    }}
                  </Show>
                )
              }}
            </For>
          </div>

          <Show when={commits().length === 0}>
            <div class="px-3 py-3 text-[11px] text-text-dim text-center">
              No commits on this branch yet
            </div>
          </Show>
        </div>
      </Show>

      <ContextMenu
        open={!!menu()}
        onClose={closeMenu}
        pos={menu() ? { x: menu()!.x, y: menu()!.y } : undefined}
        minWidth="min-w-44"
        items={menuItems()}
      />
    </div>
  )
}
