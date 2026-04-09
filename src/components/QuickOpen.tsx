import { Component, Show, For, createSignal, createEffect, on } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { Search, File, FileCode, FileJson, FileText } from 'lucide-solid'
import { showQuickOpen, setShowQuickOpen, openFile, setRightPanelTab } from '../store/files'
import { selectedTaskId } from '../store/ui'
import * as ipc from '../lib/ipc'

// ── Fuzzy match scoring ────────────────────────────────────────────────
function fuzzyMatch(query: string, path: string): number | null {
  if (!query) return 0
  const lower = path.toLowerCase()
  const q = query.toLowerCase()

  // Try substring match first
  const idx = lower.indexOf(q)
  if (idx === -1) return null

  // Score: prefer matches in filename over path
  const nameStart = lower.lastIndexOf('/') + 1
  if (idx >= nameStart) return 2000 - idx + nameStart // filename match — high priority
  return 1000 - idx // path match — lower priority
}

// ── File icon by extension ─────────────────────────────────────────────
function getIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'rs': case 'py':
    case 'go': case 'java': case 'c': case 'cpp': case 'html': case 'css':
    case 'vue': case 'svelte': case 'sh':
      return FileCode
    case 'json': case 'jsonc':
      return FileJson
    case 'md': case 'txt':
      return FileText
    default:
      return File
  }
}

// ── Component ──────────────────────────────────────────────────────────
export const QuickOpen: Component = () => {
  const [query, setQuery] = createSignal('')
  const [files, setFiles] = createSignal<string[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let inputRef: HTMLInputElement | undefined
  let scrollRef: HTMLDivElement | undefined

  // Load files when overlay opens
  createEffect(on(showQuickOpen, (open) => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)

    // Focus input after DOM renders (double-rAF for Solid's Show)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef?.focus())
    })

    // Load file list async
    const taskId = selectedTaskId()
    if (!taskId) return
    ipc.listWorktreeFiles(taskId).then(setFiles).catch(() => setFiles([]))
  }))

  // Filtered results
  const filtered = () => {
    const q = query()
    if (!q) return files().slice(0, 500) // Show all (capped) when no query
    const scored: Array<{ path: string; score: number }> = []
    for (const path of files()) {
      const score = fuzzyMatch(q, path)
      if (score !== null) scored.push({ path, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 200).map(s => s.path)
  }

  // Reset selection when query changes
  createEffect(on(query, () => setSelectedIndex(0)))

  const close = () => setShowQuickOpen(false)

  const openSelected = () => {
    const results = filtered()
    const path = results[selectedIndex()]
    if (!path) return
    const name = path.split('/').pop() || path
    openFile(path, name)
    setRightPanelTab('files')
    close()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const results = filtered()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openSelected()
    }
  }

  // Close on click outside
  const handleBackdropClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('quick-open-backdrop')) {
      close()
    }
  }

  // Virtualizer for results
  const virtualizer = createVirtualizer({
    get count() { return filtered().length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 32,
    overscan: 5,
  })

  // Scroll selected item into view
  createEffect(on(selectedIndex, (idx) => {
    virtualizer.scrollToIndex(idx, { align: 'auto' })
  }))

  return (
    <Show when={showQuickOpen()}>
      <div
        class="quick-open-backdrop fixed inset-0 z-200 bg-black/50 flex items-start justify-center pt-[15vh]"
        onClick={handleBackdropClick}
      >
        <div
          class="w-[520px] max-h-[400px] bg-[#21252b] border border-[#181a1f] rounded-lg overflow-hidden flex flex-col"
          style={{ 'box-shadow': '0 8px 32px rgba(0,0,0,0.6)' }}
        >
          {/* Search input */}
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-[#181a1f]">
            <Search size={14} class="text-[#5c6370] shrink-0" />
            <input
              ref={inputRef}
              class="flex-1 bg-transparent text-[#abb2bf] text-[13px] outline-none placeholder-[#5c6370]"
              placeholder="Search files by name..."
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          {/* Results */}
          <div ref={scrollRef} class="flex-1 overflow-auto" style={{ 'max-height': '340px' }}>
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-4 py-8 text-center text-[#5c6370] text-xs">
                  {query() ? 'No files match your search' : 'No files found'}
                </div>
              }
            >
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                <For each={virtualizer.getVirtualItems()}>
                  {(virtualRow) => {
                    const path = () => filtered()[virtualRow.index]
                    const name = () => path()?.split('/').pop() || ''
                    const dir = () => {
                      const p = path()
                      if (!p) return ''
                      const lastSlash = p.lastIndexOf('/')
                      return lastSlash > 0 ? p.substring(0, lastSlash) : ''
                    }
                    const isSelected = () => virtualRow.index === selectedIndex()
                    return (
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <button
                          class={`w-full flex items-center gap-2 px-3 py-1 text-left transition-colors ${
                            isSelected()
                              ? 'bg-[#2c313a] text-[#abb2bf]'
                              : 'text-[#7f848e] hover:bg-[#2c313a]/50'
                          }`}
                          onClick={() => {
                            setSelectedIndex(virtualRow.index)
                            openSelected()
                          }}
                          onMouseEnter={() => setSelectedIndex(virtualRow.index)}
                        >
                          {(() => { const I = getIcon(name()); return <I size={14} class="shrink-0 text-[#5c6370]" /> })()}
                          <span class="text-[12px] truncate">
                            <span class={isSelected() ? 'text-[#abb2bf]' : 'text-[#abb2bf]/80'}>{name()}</span>
                            <Show when={dir()}>
                              <span class="text-[#5c6370] ml-2">{dir()}</span>
                            </Show>
                          </span>
                        </button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
