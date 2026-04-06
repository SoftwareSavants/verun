import { Component, For, Show, createSignal, createEffect, on } from 'solid-js'
import { filterCommands, type Command } from '../store/commands'
import { clsx } from 'clsx'

interface Props {
  query: string
  onSelect: (command: Command) => void
  onTab: (command: Command) => void
  onDismiss: () => void
}

export const CommandPalette: Component<Props> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  const filtered = () => filterCommands(props.query)

  // Reset selection when query changes
  createEffect(on(() => props.query, () => setSelectedIndex(0)))

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
        e.preventDefault()
        props.onSelect(items[selectedIndex()])
        break
      case 'Tab':
        e.preventDefault()
        props.onTab(items[selectedIndex()])
        break
      case 'Escape':
        e.preventDefault()
        props.onDismiss()
        break
    }
  }

  // Expose keydown handler for parent to call
  ;(window as any).__commandPaletteKeyDown = handleKeyDown

  return (
    <Show when={filtered().length > 0}>
      <div class="absolute bottom-full left-0 right-0 mb-1 z-50 bg-surface-2 border border-border-active rounded-lg shadow-xl max-h-64 overflow-y-auto animate-in">
        <div class="py-1">
          <For each={filtered()}>
            {(cmd, i) => (
              <button
                class={clsx(
                  'w-full text-left px-3 py-2 flex items-center gap-3 transition-colors',
                  selectedIndex() === i()
                    ? 'bg-surface-3 text-text-primary'
                    : 'text-text-secondary hover:bg-surface-3'
                )}
                onMouseEnter={() => setSelectedIndex(i())}
                onClick={() => props.onSelect(cmd)}
              >
                <span class={clsx(
                  'text-xs font-mono shrink-0',
                  cmd.category === 'app' ? 'text-accent' : 'text-status-done'
                )}>
                  /{cmd.name}
                </span>
                <span class="text-[11px] text-text-muted truncate">{cmd.description}</span>
                <span class={clsx(
                  'text-[9px] uppercase tracking-wider ml-auto shrink-0 px-1.5 py-0.5 rounded',
                  cmd.category === 'app'
                    ? 'text-accent/60 bg-accent/5'
                    : 'text-status-done/60 bg-status-done/5'
                )}>
                  {cmd.category === 'app' ? 'app' : 'skill'}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
