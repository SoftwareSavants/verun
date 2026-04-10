import { Component, For, Show, createSignal, createEffect, on } from 'solid-js'
import { clsx } from 'clsx'
import { getFileIcon } from '../lib/fileIcons'

interface Props {
  query: string
  files: string[]
  onSelect: (filePath: string) => void
  onDismiss: () => void
}

function scoreMatch(file: string, query: string): number {
  const lower = file.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 0

  // Exact filename match scores highest
  const name = lower.split('/').pop() ?? lower
  if (name === q) return 1000
  if (name.startsWith(q)) return 500

  // Path contains query
  if (lower.includes(q)) return 100

  // Fuzzy: all query chars appear in order
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++
  }
  if (qi === q.length) return 10

  return -1
}

export const FileMention: Component<Props> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  const filtered = () => {
    const q = props.query
    if (!q) return props.files.slice(0, 50)

    const scored = props.files
      .map(f => ({ file: f, score: scoreMatch(f, q) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)

    return scored.map(x => x.file)
  }

  let listRef!: HTMLDivElement

  createEffect(on(() => props.query, () => {
    setSelectedIndex(0)
    listRef?.scrollTo(0, 0)
  }))

  const handleKeyDown = (e: KeyboardEvent) => {
    const items = filtered()
    if (items.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(i => (i + 1) % items.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(i => (i - 1 + items.length) % items.length)
        break
      case 'Enter':
      case 'Tab':
        e.preventDefault()
        props.onSelect(items[selectedIndex()])
        break
      case 'Escape':
        e.preventDefault()
        props.onDismiss()
        break
    }
  }

  ;(window as any).__fileMentionKeyDown = handleKeyDown

  // File icons imported from ../lib/fileIcons

  return (
    <Show when={filtered().length > 0}>
      <div ref={listRef} class="absolute bottom-full left-0 right-0 mb-1 z-50 bg-surface-2 border border-border-active rounded-lg shadow-xl max-h-64 overflow-y-auto animate-in">
        <div class="px-3 py-1.5 text-[10px] text-text-dim uppercase tracking-wider border-b border-border">
          Files
        </div>
        <div class="py-1">
          <For each={filtered()}>
            {(file, i) => {
              const parts = file.split('/')
              const name = parts.pop() ?? file
              const dir = parts.join('/')
              return (
                <button
                  class={clsx(
                    'w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors',
                    selectedIndex() === i()
                      ? 'bg-surface-3 text-text-primary'
                      : 'text-text-secondary hover:bg-surface-3'
                  )}
                  onMouseEnter={() => setSelectedIndex(i())}
                  onClick={() => props.onSelect(file)}
                >
                  <span class="shrink-0">{(() => { const I = getFileIcon(name); return <I size={12} /> })()}</span>
                  <span class="text-xs font-mono truncate">
                    <span class="text-text-primary">{name}</span>
                    <Show when={dir}>
                      <span class="text-text-dim ml-1.5">{dir}/</span>
                    </Show>
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}
