import { Component, For, Show, createSignal, createEffect } from 'solid-js'
import { Plus, X, Square, Loader2, Check, AlertCircle, RotateCcw } from 'lucide-solid'
import { clsx } from 'clsx'
import { terminalsForTask, activeTerminalId, setActiveTerminalForTask, spawnTerminal, closeTerminal, focusActiveTerminal, terminalExitCodes, isTerminalStopped, spawnStartCommand, isTaskHydrated } from '../store/terminals'
import { isSetupRunning } from '../store/setup'
import { ShellTerminal } from './ShellTerminal'
import * as ipc from '../lib/ipc'

interface Props {
  taskId: string
  startCommand?: string
  autoStart?: boolean
}

export const TerminalPanel: Component<Props> = (props) => {
  const [spawning, setSpawning] = createSignal(false)

  const taskTerminals = () => terminalsForTask(props.taskId)
  const activeId = () => activeTerminalId(props.taskId)

  // Sort: setup hooks first, then start command, then other hooks, then regular shells
  const sortedTerminals = () => {
    const all = taskTerminals()
    const setup = all.filter(t => t.hookType === 'setup')
    const start = all.filter(t => t.isStartCommand)
    const otherHooks = all.filter(t => t.hookType && t.hookType !== 'setup')
    const regular = all.filter(t => !t.hookType && !t.isStartCommand)
    return [...setup, ...start, ...otherHooks, ...regular]
  }

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

  const handleStopHook = async (e: MouseEvent) => {
    e.stopPropagation()
    try {
      await ipc.stopHook(props.taskId)
    } catch (err) {
      console.error('Failed to stop hook:', err)
    }
  }

  const handleRerunHook = async (hookType: 'setup' | 'destroy', e: MouseEvent) => {
    e.stopPropagation()
    try {
      await ipc.runHook(props.taskId, hookType)
    } catch (err) {
      console.error('Failed to re-run hook:', err)
    }
  }

  // Auto-spawn first terminal if none exist. Wait for hydration first so we
  // don't spawn a fresh shell on top of PTYs the Rust side already has running
  // (e.g. opened from another window or surviving a window reload).
  createEffect(() => {
    if (!isTaskHydrated(props.taskId)) return
    if (taskTerminals().length > 0) return
    if (isSetupRunning(props.taskId)) return
    if (spawning()) return
    if (props.autoStart && props.startCommand) {
      setSpawning(true)
      spawnStartCommand(props.taskId, props.startCommand).finally(() => setSpawning(false))
    } else {
      handleNew()
    }
  })

  return (
    <div class="flex flex-col h-full bg-[#0a0a0a]">
      {/* Tab bar */}
      <div class="flex items-center px-2 py-1.5 gap-1 bg-surface-1 border-b border-border-subtle overflow-x-auto shrink-0">
        <For each={sortedTerminals()}>
          {(t) => {
            const isSpecial = () => !!t.hookType || !!t.isStartCommand
            const stopped = () => isTerminalStopped(t.id)
            const exitCode = () => terminalExitCodes()[t.id]
            const running = () => isSpecial() && !stopped()
            const success = () => isSpecial() && stopped() && exitCode() === 0
            const failed = () => isSpecial() && stopped() && exitCode() !== 0

            return (
              <div
                class={clsx(
                  'group flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] transition-none whitespace-nowrap cursor-pointer',
                  activeId() === t.id
                    ? 'bg-surface-3 text-text-secondary'
                    : 'text-text-dim hover:text-text-muted hover:bg-surface-2'
                )}
                onClick={() => {
                  setActiveTerminalForTask(props.taskId, t.id)
                  requestAnimationFrame(() => focusActiveTerminal(props.taskId))
                }}
              >
                {/* Status indicator for special terminals */}
                <Show when={isSpecial()}>
                  <Show when={running()}>
                    <Loader2 size={10} class="animate-spin text-accent shrink-0" />
                  </Show>
                  <Show when={success()}>
                    <Check size={10} class="text-emerald-400 shrink-0" />
                  </Show>
                  <Show when={failed()}>
                    <AlertCircle size={10} class="text-status-error shrink-0" />
                  </Show>
                </Show>

                <span>{t.name}</span>

                {/* Actions for special terminals (hooks / start command) */}
                <Show when={isSpecial()}>
                  <Show when={running()}>
                    <button
                      class="ml-0.5 text-text-dim hover:text-status-error transition-colors"
                      onClick={t.hookType ? handleStopHook : (e: MouseEvent) => { e.stopPropagation(); ipc.ptyClose(t.id) }}
                      title={t.hookType ? 'Stop hook' : 'Stop'}
                    >
                      <Square size={9} />
                    </button>
                  </Show>
                  <Show when={stopped()}>
                    <Show when={t.hookType}>
                      <button
                        class="ml-0.5 opacity-0 group-hover:opacity-100 text-text-dim hover:text-text-muted transition-all"
                        onClick={(e) => handleRerunHook(t.hookType!, e)}
                        title="Re-run hook"
                      >
                        <RotateCcw size={9} />
                      </button>
                    </Show>
                    <button
                      class="ml-0.5 opacity-0 group-hover:opacity-100 text-text-dim hover:text-text-muted transition-all"
                      onClick={(e) => handleClose(t.id, e)}
                      title="Close"
                    >
                      <X size={10} />
                    </button>
                  </Show>
                </Show>

                {/* Regular terminal close button */}
                <Show when={!isSpecial()}>
                  <button
                    class="ml-0.5 opacity-0 group-hover:opacity-100 text-text-dim hover:text-text-muted transition-all"
                    onClick={(e) => handleClose(t.id, e)}
                    title="Close terminal"
                  >
                    <X size={10} />
                  </button>
                </Show>
              </div>
            )
          }}
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
          {(t) => {
            const isSpecial = !!t.hookType || !!t.isStartCommand
            const stopped = isSpecial ? () => isTerminalStopped(t.id) : undefined
            return (
              <div
                class="absolute inset-0"
                style={{ display: activeId() === t.id ? 'block' : 'none' }}
              >
                <ShellTerminal terminalId={t.id} isStopped={stopped} />
              </div>
            )
          }}
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
