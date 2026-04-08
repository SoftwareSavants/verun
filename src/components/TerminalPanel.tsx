import { Component, For, Show, createSignal } from 'solid-js'
import { Plus, X } from 'lucide-solid'
import { clsx } from 'clsx'
import { terminalsForTask, activeTerminalId, setActiveTerminalForTask, spawnTerminal, closeTerminal, focusActiveTerminal } from '../store/terminals'
import { ShellTerminal } from './ShellTerminal'

interface Props {
  taskId: string
}

export const TerminalPanel: Component<Props> = (props) => {
  const [spawning, setSpawning] = createSignal(false)

  const taskTerminals = () => terminalsForTask(props.taskId)
  const activeId = () => activeTerminalId(props.taskId)

  const handleNew = async () => {
    if (spawning()) return
    setSpawning(true)
    try {
      await spawnTerminal(props.taskId, 24, 80)
    } finally {
      setSpawning(false)
    }
  }

  const handleClose = async (terminalId: string, e: MouseEvent) => {
    e.stopPropagation()
    await closeTerminal(terminalId)
  }

  // Auto-spawn first terminal if none exist
  if (taskTerminals().length === 0) {
    handleNew()
  }

  return (
    <div class="flex flex-col h-full bg-[#0a0a0a]">
      {/* Tab bar */}
      <div class="flex items-center px-2 py-1.5 gap-1 bg-surface-1 border-b border-border-subtle overflow-x-auto shrink-0">
        <For each={taskTerminals()}>
          {(t) => (
            <div
              class={clsx(
                'group flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] transition-all whitespace-nowrap cursor-pointer',
                activeId() === t.id
                  ? 'bg-surface-3 text-text-secondary'
                  : 'text-text-dim hover:text-text-muted hover:bg-surface-2'
              )}
              onClick={() => {
                setActiveTerminalForTask(props.taskId, t.id)
                requestAnimationFrame(() => focusActiveTerminal(props.taskId))
              }}
            >
              <span>{t.name}</span>
              <button
                class="ml-0.5 opacity-0 group-hover:opacity-100 text-text-dim hover:text-text-muted transition-all"
                onClick={(e) => handleClose(t.id, e)}
                title="Close terminal"
              >
                <X size={10} />
              </button>
            </div>
          )}
        </For>
        <button
          class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors disabled:opacity-40"
          onClick={handleNew}
          disabled={spawning()}
          title="New Terminal"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Terminal containers — all mounted, only active visible */}
      <div class="flex-1 overflow-hidden relative">
        <For each={taskTerminals()}>
          {(t) => (
            <div
              class="absolute inset-0"
              style={{ display: activeId() === t.id ? 'block' : 'none' }}
            >
              <ShellTerminal terminalId={t.id} />
            </div>
          )}
        </For>
        <Show when={taskTerminals().length === 0}>
          <div class="flex items-center justify-center h-full text-text-dim text-xs">
            No terminals open
          </div>
        </Show>
      </div>
    </div>
  )
}
