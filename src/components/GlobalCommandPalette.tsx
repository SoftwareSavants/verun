import { Component, Show, For, createSignal, createEffect, on } from 'solid-js'
import { selectedTaskId, setShowSettings, setShowArchived } from '../store/ui'
import { taskById } from '../store/tasks'
import { restartLspServer } from '../lib/lsp'
import { spawnStartCommand } from '../store/terminals'
import { projectById } from '../store/projects'
import { clearProblemsForTask } from '../store/problems'

interface Command {
  id: string
  label: string
  detail?: string
  action: () => void
}

const [showGlobalPalette, setShowGlobalPalette] = createSignal(false)
export { showGlobalPalette, setShowGlobalPalette }

export const GlobalCommandPalette: Component = () => {
  const [query, setQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined

  const commands = (): Command[] => {
    const taskId = selectedTaskId()
    const task = taskId ? taskById(taskId) : undefined
    const project = task ? projectById(task.projectId) : undefined

    const cmds: Command[] = [
      {
        id: 'restart-ts',
        label: 'Restart TypeScript Server',
        action: () => {
          if (taskId) {
            clearProblemsForTask(taskId)
            restartLspServer(taskId)
          }
        },
      },
      {
        id: 'settings',
        label: 'Open Settings',
        detail: '\u2318,',
        action: () => setShowSettings(true),
      },
      {
        id: 'archived',
        label: 'Open Archived Tasks',
        action: () => setShowArchived(true),
      },
    ]

    if (taskId && project?.startCommand) {
      cmds.push({
        id: 'start',
        label: 'Start Dev Server',
        action: () => spawnStartCommand(taskId, project!.startCommand),
      })
    }

    return cmds
  }

  const filtered = () => {
    const q = query().toLowerCase()
    if (!q) return commands()
    return commands().filter(c =>
      c.label.toLowerCase().includes(q) ||
      (c.detail?.toLowerCase().includes(q))
    )
  }

  createEffect(on(showGlobalPalette, (open) => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef?.focus())
    })
  }))

  createEffect(on(query, () => setSelectedIndex(0)))

  const close = () => setShowGlobalPalette(false)

  const runSelected = () => {
    const results = filtered()
    const cmd = results[selectedIndex()]
    if (!cmd) return
    close()
    cmd.action()
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
      runSelected()
    }
  }

  return (
    <Show when={showGlobalPalette()}>
      <div
        class="fixed inset-0 z-200 bg-black/50 flex items-start justify-center pt-[15vh]"
        onClick={(e) => { if (e.target === e.currentTarget) close() }}
      >
        <div class="w-[520px] max-h-[340px] bg-surface-2 ring-1 ring-outline/8 rounded-lg shadow-2xl overflow-hidden flex flex-col">
          <div class="flex items-center gap-2 px-3 py-2.5 border-b border-border">
            <span class="text-text-muted text-[13px] shrink-0">&gt;</span>
            <input
              ref={inputRef}
              class="flex-1 bg-transparent text-text-primary text-[13px] outline-none placeholder-text-dim"
              placeholder="Type a command..."
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
            />
          </div>

          <div class="flex-1 overflow-auto" style={{ 'max-height': '280px' }}>
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-4 py-8 text-center text-text-dim text-xs">
                  No commands match
                </div>
              }
            >
              <For each={filtered()}>
                {(cmd, i) => (
                  <button
                    class={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${
                      i() === selectedIndex()
                        ? 'bg-surface-3 text-text-primary'
                        : 'text-text-secondary hover:bg-surface-3/50'
                    }`}
                    onClick={() => {
                      setSelectedIndex(i())
                      runSelected()
                    }}
                    onMouseEnter={() => setSelectedIndex(i())}
                  >
                    <span class="text-[12px]">{cmd.label}</span>
                    <Show when={cmd.detail}>
                      <span class="text-[11px] text-text-dim ml-4 shrink-0">{cmd.detail}</span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
