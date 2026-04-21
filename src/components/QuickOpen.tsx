import { Component, Show, For, createSignal, createEffect, on, onCleanup } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { Search, X } from 'lucide-solid'
import { getFileIcon } from '../lib/fileIcons'
import { openFilePinned, revealFileInTree } from '../store/editorView'
import { showQuickOpen, setShowQuickOpen } from '../store/ui'
import { selectedTaskId } from '../store/ui'
import { removeRecentFile, recentFilesForTask } from '../store/recentFiles'
import { taskById } from '../store/tasks'
import * as ipc from '../lib/ipc'

// ── Fuzzy match scoring ────────────────────────────────────────────────
// Character-by-character fuzzy match like VS Code:
// - Each query char must appear in order in the path
// - Bonuses for: consecutive matches, word boundary matches (after / _ . -),
//   camelCase boundaries, filename matches over path matches
// - "numforhelp" matches "number_format_helper.ts"
// - "src/app" matches "src/components/App.tsx"
function fuzzyMatch(query: string, path: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const p = path.toLowerCase()
  const nameStart = p.lastIndexOf('/') + 1

  let score = 0
  let qi = 0
  let consecutive = 0
  let prevMatchIdx = -2

  for (let pi = 0; pi < p.length && qi < q.length; pi++) {
    if (p[pi] === q[qi]) {
      qi++

      // Consecutive match bonus
      if (pi === prevMatchIdx + 1) {
        consecutive++
        score += 5 + consecutive * 2
      } else {
        consecutive = 0
        score += 1
      }

      // Word boundary bonus: after / _ . - or camelCase
      if (pi === 0 || '/_.-'.includes(p[pi - 1])) {
        score += 10
      } else if (
        pi > 0 &&
        path[pi] === path[pi].toUpperCase() &&
        path[pi - 1] === path[pi - 1].toLowerCase()
      ) {
        // camelCase boundary
        score += 8
      }

      // Filename match bonus (matches in the filename score higher)
      if (pi >= nameStart) {
        score += 3
      }

      // Exact start of filename bonus
      if (pi === nameStart) {
        score += 15
      }

      prevMatchIdx = pi
    }
  }

  // All query chars must be matched
  if (qi < q.length) return null

  return score
}

// getFileIcon imported from ../lib/fileIcons

// ── Component ──────────────────────────────────────────────────────────
export const QuickOpen: Component = () => {
  const [query, setQuery] = createSignal('')
  const [files, setFiles] = createSignal<string[]>([])
  const [recentVersion, setRecentVersion] = createSignal(0)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let inputRef: HTMLInputElement | undefined
  let scrollRef: HTMLDivElement | undefined

  const focusInput = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef?.focus())
    })
  }

  // Load files when overlay opens
  createEffect(on(showQuickOpen, (open) => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)

    // Focus input after DOM renders (double-rAF for Solid's Show)
    focusInput()

    // Load file list async
    const taskId = selectedTaskId()
    if (!taskId) return
    ipc.listWorktreeFiles(taskId).then(setFiles).catch(() => setFiles([]))
  }))

  createEffect(() => {
    if (!showQuickOpen()) return

    const refocusIfNeeded = () => {
      if (!showQuickOpen()) return
      if (document.visibilityState !== 'visible') return
      focusInput()
    }

    window.addEventListener('focus', refocusIfNeeded)
    document.addEventListener('visibilitychange', refocusIfNeeded)
    onCleanup(() => {
      window.removeEventListener('focus', refocusIfNeeded)
      document.removeEventListener('visibilitychange', refocusIfNeeded)
    })
  })

  // Filtered results
  type QuickOpenResult = {
    path: string
    isRecent: boolean
  }

  const filtered = () => {
    const q = query()
    recentVersion()

    const recent = recentFilesForTask(selectedTaskId())
    const recentSet = new Set(recent)

    if (!q) {
      const results: QuickOpenResult[] = recent.map(path => ({
        path,
        isRecent: true,
      }))

      for (const path of files()) {
        if (recentSet.has(path)) continue
        results.push({ path, isRecent: false })
      }

      return results.slice(0, 500)
    }

    const scored: Array<QuickOpenResult & { score: number }> = []
    for (const path of recent) {
      const score = fuzzyMatch(q, path)
      if (score !== null) {
        scored.push({
          path,
          isRecent: true,
          score: score + 1000 - scored.length,
        })
      }
    }
    for (const path of files()) {
      if (recentSet.has(path)) continue
      const score = fuzzyMatch(q, path)
      if (score !== null) {
        scored.push({ path, isRecent: false, score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 200).map(({ score: _score, ...result }) => result)
  }

  // Reset selection when query changes
  createEffect(on(query, () => setSelectedIndex(0)))

  const close = () => setShowQuickOpen(false)

  const openSelected = () => {
    const results = filtered()
    const path = results[selectedIndex()]?.path
    if (!path) return
    const name = path.split('/').pop() || path
    const taskId = selectedTaskId()
    if (!taskId) return
    openFilePinned(taskId, path, name)
    revealFileInTree(taskId, path)
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

  const handleRemoveRecent = (path: string, e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const task = taskById(selectedTaskId() ?? '')
    if (!task) return
    removeRecentFile(task.projectId, path)
    setRecentVersion(v => v + 1)
    setSelectedIndex(i => Math.max(0, Math.min(i, filtered().length - 1)))
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
        <div class="w-[520px] max-h-[400px] bg-surface-2 ring-1 ring-outline/8 rounded-lg shadow-2xl overflow-hidden flex flex-col">
          {/* Search input */}
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-border">
            <Search size={14} class="text-text-muted shrink-0" />
            <input
              ref={inputRef}
              class="flex-1 bg-transparent text-text-primary text-[13px] outline-none placeholder-text-dim"
              placeholder="Search files by name..."
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
            />
          </div>

          {/* Results */}
          <div ref={scrollRef} class="flex-1 overflow-auto" style={{ 'max-height': '340px' }}>
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-4 py-8 text-center text-text-dim text-xs">
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
                    const result = () => filtered()[virtualRow.index]
                    const path = () => result()?.path || ''
                    const name = () => path().split('/').pop() || ''
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
                        <div
                          class={`w-full flex items-center gap-2 px-3 py-1 transition-colors ${
                            isSelected()
                              ? 'bg-surface-3 text-text-primary'
                              : 'text-text-secondary hover:bg-surface-3/50'
                          }`}
                          onMouseEnter={() => setSelectedIndex(virtualRow.index)}
                        >
                          <button
                            class="min-w-0 flex-1 flex items-center gap-2 text-left"
                            onClick={() => {
                              setSelectedIndex(virtualRow.index)
                              openSelected()
                            }}
                          >
                            {(() => { const I = getFileIcon(name()); return <I size={14} class="shrink-0" /> })()}
                            <span class="text-[12px] truncate">
                              <span class={isSelected() ? 'text-text-primary' : 'text-text-secondary'}>{name()}</span>
                              <Show when={dir()}>
                                <span class="text-text-dim ml-2">{dir()}</span>
                              </Show>
                            </span>
                          </button>
                          <Show when={result()?.isRecent}>
                            <button
                              class="shrink-0 p-1 rounded text-text-dim hover:text-text-primary hover:bg-surface-3"
                              onClick={(e) => handleRemoveRecent(path(), e)}
                              aria-label={`Remove ${path()} from recent files`}
                              title="Remove from recent files"
                            >
                              <X size={12} />
                            </button>
                          </Show>
                        </div>
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
